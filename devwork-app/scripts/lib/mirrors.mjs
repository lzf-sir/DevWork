/**
 * 国产镜像源（npmmirror）的**单一来源**。
 *
 * 为什么要有这个文件，而不是「在 .npmrc 里写一遍、在脚本里再写一遍」：
 * 打包链路里下载东西的有三方，各自认不同的环境变量，写散了一定会漂：
 *
 *   npm install / npm ci        → registry（也可 `--registry` 覆盖）
 *   electron 包 postinstall     → @electron/get 读 ELECTRON_MIRROR
 *   electron-builder            → app-builder-lib 读 ELECTRON_BUILDER_BINARIES_MIRROR
 *                                 （下载 nsis / winCodeSign / app-builder）
 *
 * `.npmrc` 负责「人直接在 devwork-app 里敲 npm install」这条路径（npm 会把
 * electron_mirror 等键导出成 npm_config_* 交给生命周期脚本）；
 * 这里负责「脚本 spawn 出去的子进程」——那些进程不一定经过 npm，尤其
 * `electron-builder` 是我们用 `npm exec` 拉起来的，环境变量才是可靠通路。
 *
 * 解析优先级（高 → 低）：
 *   DEVWORK_<X> 覆盖值（DEVWORK_NPM_REGISTRY / DEVWORK_ELECTRON_MIRROR /
 *                        DEVWORK_ELECTRON_BUILDER_MIRROR）
 *   → 本文件的默认值（npmmirror）
 *   → DEVWORK_MIRROR=off 时整体关闭，一切走官方源（境外网络 / 排查镜像故障用）
 *
 * 注意 .npmrc 里的 electron_mirror 会让 npm 打一句 `Unknown project config`
 * 警告 —— 那是预期噪音，不是配置错误（见 .npmrc 顶部注释）。
 */

/** npm 依赖源（registry）。 */
export const NPM_REGISTRY = 'https://registry.npmmirror.com';

/**
 * Electron 预编译二进制。
 *
 * 路径规则必须和 @electron/get 拼出来的完全一致：
 *   `${ELECTRON_MIRROR}${customDir=版本号}/${file}`
 * → https://npmmirror.com/mirrors/electron/33.4.11/electron-v33.4.11-win32-x64.zip
 * 末尾的斜杠不能省（artifact-utils.js 是直接字符串拼接，不补分隔符）。
 */
export const ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';

/**
 * electron-builder 的二进制源（GitHub releases 的镜像）。
 * 路径规则见 app-builder-lib/out/binDownload.js：`${base}${middle}/${dir}.7z`
 * → https://npmmirror.com/mirrors/electron-builder-binaries/nsis-3.0.4.1/nsis-3.0.4.1.7z
 */
export const ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/';

/** 认作「关闭镜像」的取值（不分大小写）。 */
const OFF_VALUES = new Set(['0', 'off', 'false', 'no', 'none']);

/** 镜像总开关：默认开；`DEVWORK_MIRROR=off` 关。 */
export function mirrorsEnabled(env = process.env) {
  const flag = String(env.DEVWORK_MIRROR ?? '').trim().toLowerCase();
  return !OFF_VALUES.has(flag);
}

function override(env, key, fallback) {
  const value = String(env[key] ?? '').trim();
  return value || fallback;
}

/**
 * 当前生效的三处镜像。关闭时各字段为空串（调用方据此决定是否传参）。
 *
 * @returns {{enabled: boolean, registry: string, electronMirror: string, builderBinariesMirror: string}}
 */
export function mirrorSettings(env = process.env) {
  if (!mirrorsEnabled(env)) {
    return { enabled: false, registry: '', electronMirror: '', builderBinariesMirror: '' };
  }
  return {
    enabled: true,
    registry: override(env, 'DEVWORK_NPM_REGISTRY', NPM_REGISTRY),
    electronMirror: override(env, 'DEVWORK_ELECTRON_MIRROR', ELECTRON_MIRROR),
    /* 变量名有点长：DEVWORK_ELECTRON_BUILDER_MIRROR 指的就是
     * electron-builder-binaries 那套二进制（不是 electron 本身）。 */
    builderBinariesMirror: override(env, 'DEVWORK_ELECTRON_BUILDER_MIRROR', ELECTRON_BUILDER_BINARIES_MIRROR),
  };
}

/**
 * 交给子进程的环境变量增量（**不**包含 process.env，调用方自己展开）。
 *
 * 只写「没有被外部显式设置」的变量：外部已经设了 ELECTRON_MIRROR 就尊重外部，
 * 不再拿默认值盖掉 —— 否则在境外网络下想临时指回官方源会失效。
 */
export function mirrorEnv(env = process.env) {
  const settings = mirrorSettings(env);
  if (!settings.enabled) return {};
  const out = {};
  if (!env.ELECTRON_MIRROR) out.ELECTRON_MIRROR = settings.electronMirror;
  if (!env.ELECTRON_BUILDER_BINARIES_MIRROR) {
    out.ELECTRON_BUILDER_BINARIES_MIRROR = settings.builderBinariesMirror;
  }
  return out;
}

/**
 * 把镜像环境变量**注入当前进程**，让之后所有 spawn 的子进程自动继承。
 *
 * package.mjs 在开头调一次即可覆盖全链路（build / preflight / smoke / electron-builder）：
 * lib/common.mjs 的 run() 是 `{...process.env, ...options.env}`，天然继承。
 */
export function applyMirrors(env = process.env) {
  const settings = mirrorSettings(env);
  if (settings.enabled) Object.assign(process.env, mirrorEnv(env));
  return settings;
}

/** 给 npm 子命令用的 registry 参数（关闭镜像时返回空数组）。 */
export function npmRegistryArgs(env = process.env) {
  const settings = mirrorSettings(env);
  return settings.enabled && settings.registry ? [`--registry`, settings.registry] : [];
}

/**
 * 一行人类可读的镜像摘要，打日志用。
 * 出问题时第一眼看的就是这行 —— 「到底走没走镜像」不该靠猜。
 */
export function describeMirrors(env = process.env) {
  const settings = mirrorSettings(env);
  if (!settings.enabled) {
    return '镜像源已关闭（DEVWORK_MIRROR=off）→ 走官方源：registry.npmjs.org / github.com';
  }
  return `镜像源 → npm ${settings.registry} · electron ${settings.electronMirror} · builder ${settings.builderBinariesMirror}`;
}
