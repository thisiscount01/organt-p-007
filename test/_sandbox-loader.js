'use strict';
/**
 * 샌드박스 CommonJS 로더 — 이 작업공간 절대경로(비ASCII 세그먼트 "레이드-rpg" 포함)에서 Node의
 * 표준 require()/module 해석이 통째로 깨지는(MODULE_NOT_FOUND, 파일이 실재해도) 환경결함을
 * 우회하기 위한 최소 재구현이다.
 *
 * 원인 재확인(코드 문제로 단정하기 전에 절대경로 vs 상대경로 fs 접근을 대조한 결과, 2026-07-09):
 * - fs.existsSync('./server.js') 등 **상대경로** fs 호출은 전부 정상.
 * - fs.statSync(process.cwd()+'/server.js') 등 **절대경로** fs 호출은 EACCES(조상 디렉터리 권한
 *   거부 — 파일 자체가 없는 게 아니라 절대경로로 접근할 권한이 없음).
 * - require('./server.js')·require('express') 둘 다 이 절대경로 EACCES 때문에 내부적으로
 *   MODULE_NOT_FOUND로 실패(상대/bare 무관 — Node의 CJS 리졸버가 내부적으로 절대경로화해서 stat함).
 * - node 내장모듈(fs/path/http/crypto/module/vm 등)은 require()로 정상 로드됨(내장은 파일시스템
 *   경로 해석을 안 거치므로 안 깨짐).
 * - `node test/foo.js`처럼 파일을 엔트리포인트로 직접 실행하는 것도 동일하게 깨짐(엔트리 자체를
 *   못 찾음) — 그래서 실행은 항상 `node -e "..."`(eval 진입점, cwd 기준 상대경로만 사용)로
 *   시작해야 한다.
 *
 * 설계: "가상 절대경로" 공간을 이 로더 안에서만 흉내낸다 — 워크스페이스 루트를 가상의 '/'로 두고
 * __dirname/__filename을 실제 Node처럼 '/lib', '/test/dodge-check.js' 같은 절대경로"처럼 보이는"
 * 문자열로 각 모듈에 주입한다. path.resolve/path.join은 세그먼트가 이미 '/'로 시작하면 순수
 * 문자열 연산만 하고 실제 cwd/파일시스템을 안 건드리므로(Node path 모듈 자체 동작), 기존 코드의
 * `path.join(__dirname, '..', 'lib', 'x.js')` 같은 패턴이 실제 Node에서와 똑같이 동작한다.
 * 실제 fs 접근이 필요한 시점(파일 읽기/존재확인)에만 이 가상절대경로를 진짜 상대경로로 변환한다
 * (toRealPath: 맨 앞 '/'를 떼고 '.'을 붙임 — 즉 '/lib/x.js' → './lib/x.js', 이 변환된 문자열만
 * fs.readFileSync 등에 넘어가므로 EACCES를 절대 안 밟는다).
 *
 * 사용법(신규 검증 스크립트/QA 재사용 공통 패턴 — 이 파일 자체도 실제 require()로 못 불러올 수
 * 있으니 항상 fs+new Function 부트스트랩으로 먼저 이 로더 자체를 로드한다):
 *   node -e "
 *     const fs = require('fs');
 *     const code = fs.readFileSync('./test/_sandbox-loader.js', 'utf8');
 *     const mod = { exports: {} };
 *     new Function('module','exports','require','__filename','__dirname', code)(
 *       mod, mod.exports, require, '/test/_sandbox-loader.js', '/test');
 *     const loader = mod.exports;
 *     const { server, io, roomManager, balance } = loader.run('/server.js');
 *     server.listen(0, () => { ... });
 *   "
 * (__filename/__dirname 인자는 반드시 '/'로 시작하는 가상절대경로 문자열로 줄 것 — 실제 절대경로
 * 문자열을 주면 안 됨, 그건 이 우회의 전제를 깨뜨린다.)
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const BUILTIN_SET = new Set(Module.builtinModules);

// 로드된 모듈 캐시 — 가상절대경로 키(예: '/lib/encounter.js'). exports 싱글턴 보장 +
// 순환 require 시 무한루프 방지.
const cache = new Map();

function isBuiltin(specifier) {
  if (specifier.startsWith('node:')) return true;
  return BUILTIN_SET.has(specifier);
}

// 로드된 앱코드(server.js/lib/*/node_modules 패키지들)는 __dirname을 우리가 준 가상절대경로로
// 알고 있어서, 자기 내부에서 `path.join(__dirname, 'x')` 같은 걸 직접 계산해 그 결과를 fs에
// 넘길 수 있다(예: lib/store.js의 DATA_DIR, server.js의 balance.json 로드, express.static이
// 쓰는 send/serve-static 패키지의 파일서빙). 그 경로들은 우리 require() 가로채기를 안 거치므로,
// "앱코드가 보는 fs 모듈 자체"를 패치해 모든 인자 중 '/'로 시작하는 문자열을 실제 상대경로로
// 변환한 뒤 진짜 fs에 위임한다 — 이러면 앱코드는 한 줄도 안 바꿔도 된다.
let patchedFsSingleton = null;
function isConstructorLikeName(name) {
  return /^[A-Z]/.test(name); // ReadStream/WriteStream/Dir/Dirent/Stats/FSWatcher 등 — new로만 호출됨
}
function convertVirtualArg(a) {
  return typeof a === 'string' && a.startsWith('/') ? toRealPath(a) : a;
}
function wrapFsLike(real) {
  const wrapped = {};
  for (const key of Object.getOwnPropertyNames(real)) {
    let val;
    try {
      val = real[key];
    } catch (_) {
      continue;
    }
    if (typeof val === 'function' && !isConstructorLikeName(key)) {
      wrapped[key] = (...args) => val.apply(real, args.map(convertVirtualArg));
    } else if (key === 'promises' && val && typeof val === 'object') {
      wrapped[key] = wrapFsLike(val);
    } else {
      wrapped[key] = val; // 상수(fs.constants)·생성자(fs.ReadStream 등)는 그대로 통과
    }
  }
  return wrapped;
}
function getPatchedFs() {
  if (!patchedFsSingleton) patchedFsSingleton = wrapFsLike(fs);
  return patchedFsSingleton;
}

// 가상절대경로('/lib/x.js') → 실제 fs 호출에 쓸 상대경로('./lib/x.js'). 이 함수를 거친 문자열만
// fs.* 에 넘긴다 — 이 샌드박스에서 절대경로 fs는 EACCES이므로 여기서 반드시 상대화한다.
function toRealPath(virtualPath) {
  if (virtualPath === '/' || virtualPath === '') return '.';
  return `.${virtualPath}`;
}

// virtualBasePath(가상절대경로, 확장자 없을 수도 있음)가 파일로 존재하면 그 가상절대경로를 반환
// (정확히 / .js / .json / /index.js 순으로 시도) — Node의 실제 확장자 생략 규칙 근사.
function resolveAsFile(virtualBasePath) {
  const candidates = [
    virtualBasePath,
    `${virtualBasePath}.js`,
    `${virtualBasePath}.json`,
    `${virtualBasePath}/index.js`,
  ];
  for (const v of candidates) {
    try {
      const st = fs.statSync(toRealPath(v));
      if (st.isFile()) return v;
    } catch (_) {
      /* 다음 후보 */
    }
  }
  return null;
}

// package.json의 main(없으면 exports['.'])을 읽어 엔트리 파일을 찾는다. pkgVirtualDir도 가상절대경로.
function resolvePackageMain(pkgVirtualDir) {
  let main = 'index.js';
  try {
    const pkg = JSON.parse(fs.readFileSync(toRealPath(`${pkgVirtualDir}/package.json`), 'utf8'));
    if (typeof pkg.main === 'string' && pkg.main) {
      main = pkg.main;
    } else if (pkg.exports) {
      const exp = pkg.exports;
      const dot = typeof exp === 'string' ? exp : exp['.'];
      if (typeof dot === 'string') main = dot;
      else if (dot && typeof dot === 'object') {
        main = dot.require || dot.node || dot.default || main;
      }
    }
  } catch (_) {
    /* package.json 없거나 파싱 실패 — index.js 폴백 */
  }
  return (
    resolveAsFile(path.posix.join(pkgVirtualDir, main)) || resolveAsFile(path.posix.join(pkgVirtualDir, 'index.js'))
  );
}

// bare specifier(npm 패키지) — fromVirtualDir부터 조상으로 올라가며 node_modules/<pkg>를 찾는다
// (Node의 실제 알고리즘과 동일한 "가까운 node_modules 우선" 규칙, require.resolve 없이 fs만 사용).
function resolveBare(fromVirtualDir, specifier) {
  // 스코프 패키지(@scope/name)와 서브패스(pkg/sub/path) 둘 다 지원.
  const parts = specifier.split('/');
  const pkgName = specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  const subPath = specifier.startsWith('@') ? parts.slice(2).join('/') : parts.slice(1).join('/');

  let dir = fromVirtualDir;
  for (;;) {
    const pkgDir = path.posix.join(dir, 'node_modules', pkgName);
    if (fs.existsSync(toRealPath(pkgDir))) {
      if (subPath) {
        const direct = resolveAsFile(path.posix.join(pkgDir, subPath));
        if (direct) return direct;
      } else {
        const main = resolvePackageMain(pkgDir);
        if (main) return main;
      }
    }
    const parent = path.posix.dirname(dir);
    if (parent === dir) break; // 가상 루트('/') 도달
    dir = parent;
  }
  return null;
}

function resolveSpecifier(fromVirtualDir, specifier) {
  if (specifier.startsWith('/')) {
    // 이미 가상절대경로(예: path.join(__dirname,'..','lib','x.js')가 만들어낸 결과) — 그대로 사용.
    return resolveAsFile(specifier);
  }
  if (specifier.startsWith('.')) {
    return resolveAsFile(path.posix.join(fromVirtualDir, specifier));
  }
  return resolveBare(fromVirtualDir, specifier);
}

function makeNotFoundError(specifier, fromVirtualDir) {
  const err = new Error(`[sandbox-loader] Cannot find module '${specifier}' from '${fromVirtualDir}'`);
  err.code = 'MODULE_NOT_FOUND';
  return err;
}

// 파일 하나(가상절대경로)를 로드·실행하고 module.exports를 반환. 캐시로 싱글턴 보장.
function loadFile(virtualPath) {
  if (cache.has(virtualPath)) return cache.get(virtualPath).exports;

  if (virtualPath.endsWith('.json')) {
    const data = JSON.parse(fs.readFileSync(toRealPath(virtualPath), 'utf8'));
    cache.set(virtualPath, { exports: data });
    return data;
  }

  const virtualDir = path.posix.dirname(virtualPath);
  const mod = { exports: {} };
  cache.set(virtualPath, mod); // exports 채우기 전에 먼저 캐시 — 순환 require 시 부분 exports라도 반환.

  const localRequire = (specifier) => sandboxRequire(virtualDir, specifier);
  localRequire.cache = cache;
  localRequire.resolve = (specifier) => {
    if (isBuiltin(specifier)) return specifier;
    const resolved = resolveSpecifier(virtualDir, specifier);
    if (!resolved) throw makeNotFoundError(specifier, virtualDir);
    return resolved;
  };

  const code = fs.readFileSync(toRealPath(virtualPath), 'utf8');
  // CommonJS 래퍼와 동일한 시그니처 — 기존 노드 모듈 코드를 수정 없이 그대로 돌리기 위함.
  // eslint-disable-next-line no-new-func
  const wrapper = new Function('module', 'exports', 'require', '__filename', '__dirname', code);
  wrapper(mod, mod.exports, localRequire, virtualPath, virtualDir);
  return mod.exports;
}

// 이 저장소의 우회 대상 require()를 대체하는 함수. 내장모듈은 진짜 require()로,
// 그 외(로컬 파일·node_modules 패키지)는 전부 이 파일이 fs+new Function으로 직접 로드한다.
function sandboxRequire(fromVirtualDir, specifier) {
  if (specifier === 'fs' || specifier === 'node:fs') return getPatchedFs();
  if (isBuiltin(specifier)) return require(specifier);
  const resolved = resolveSpecifier(fromVirtualDir, specifier);
  if (!resolved) throw makeNotFoundError(specifier, fromVirtualDir);
  return loadFile(resolved);
}

// 워크스페이스 루트 기준 경로(가상절대 '/x.js' 또는 상대 './x.js' 둘 다 허용) 스크립트를 이
// 로더로 실행하고 그 module.exports를 반환. fromVirtualDir 생략 시 워크스페이스 루트('/').
function run(entryPath, fromVirtualDir) {
  const base = fromVirtualDir || '/';
  const specifier = entryPath.startsWith('/') || entryPath.startsWith('.') ? entryPath : `./${entryPath}`;
  const resolved = resolveSpecifier(base, specifier);
  if (!resolved) throw makeNotFoundError(entryPath, base);
  return loadFile(resolved);
}

module.exports = { sandboxRequire, run, resolveSpecifier, toRealPath, _cache: cache };
