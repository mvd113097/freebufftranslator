var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __publicField = (obj, key, value) => {
  __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
  return value;
};

// .wrangler/tmp/bundle-KLAA49/strip-cf-connecting-ip-header.js
function stripCfConnectingIPHeader(input, init) {
  const request = new Request(input, init);
  request.headers.delete("CF-Connecting-IP");
  return request;
}
__name(stripCfConnectingIPHeader, "stripCfConnectingIPHeader");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    return Reflect.apply(target, thisArg, [
      stripCfConnectingIPHeader.apply(null, argArray)
    ]);
  }
});

// node_modules/unenv/dist/runtime/_internal/utils.mjs
function createNotImplementedError(name) {
  return new Error(`[unenv] ${name} is not implemented yet!`);
}
__name(createNotImplementedError, "createNotImplementedError");
function notImplemented(name) {
  const fn = /* @__PURE__ */ __name(() => {
    throw createNotImplementedError(name);
  }, "fn");
  return Object.assign(fn, { __unenv__: true });
}
__name(notImplemented, "notImplemented");
function notImplementedClass(name) {
  return class {
    __unenv__ = true;
    constructor() {
      throw new Error(`[unenv] ${name} is not implemented yet!`);
    }
  };
}
__name(notImplementedClass, "notImplementedClass");

// node_modules/unenv/dist/runtime/node/internal/perf_hooks/performance.mjs
var _timeOrigin = globalThis.performance?.timeOrigin ?? Date.now();
var _performanceNow = globalThis.performance?.now ? globalThis.performance.now.bind(globalThis.performance) : () => Date.now() - _timeOrigin;
var nodeTiming = {
  name: "node",
  entryType: "node",
  startTime: 0,
  duration: 0,
  nodeStart: 0,
  v8Start: 0,
  bootstrapComplete: 0,
  environment: 0,
  loopStart: 0,
  loopExit: 0,
  idleTime: 0,
  uvMetricsInfo: {
    loopCount: 0,
    events: 0,
    eventsWaiting: 0
  },
  detail: void 0,
  toJSON() {
    return this;
  }
};
var PerformanceEntry = class {
  __unenv__ = true;
  detail;
  entryType = "event";
  name;
  startTime;
  constructor(name, options) {
    this.name = name;
    this.startTime = options?.startTime || _performanceNow();
    this.detail = options?.detail;
  }
  get duration() {
    return _performanceNow() - this.startTime;
  }
  toJSON() {
    return {
      name: this.name,
      entryType: this.entryType,
      startTime: this.startTime,
      duration: this.duration,
      detail: this.detail
    };
  }
};
__name(PerformanceEntry, "PerformanceEntry");
var PerformanceMark = /* @__PURE__ */ __name(class PerformanceMark2 extends PerformanceEntry {
  entryType = "mark";
  constructor() {
    super(...arguments);
  }
  get duration() {
    return 0;
  }
}, "PerformanceMark");
var PerformanceMeasure = class extends PerformanceEntry {
  entryType = "measure";
};
__name(PerformanceMeasure, "PerformanceMeasure");
var PerformanceResourceTiming = class extends PerformanceEntry {
  entryType = "resource";
  serverTiming = [];
  connectEnd = 0;
  connectStart = 0;
  decodedBodySize = 0;
  domainLookupEnd = 0;
  domainLookupStart = 0;
  encodedBodySize = 0;
  fetchStart = 0;
  initiatorType = "";
  name = "";
  nextHopProtocol = "";
  redirectEnd = 0;
  redirectStart = 0;
  requestStart = 0;
  responseEnd = 0;
  responseStart = 0;
  secureConnectionStart = 0;
  startTime = 0;
  transferSize = 0;
  workerStart = 0;
  responseStatus = 0;
};
__name(PerformanceResourceTiming, "PerformanceResourceTiming");
var PerformanceObserverEntryList = class {
  __unenv__ = true;
  getEntries() {
    return [];
  }
  getEntriesByName(_name, _type) {
    return [];
  }
  getEntriesByType(type) {
    return [];
  }
};
__name(PerformanceObserverEntryList, "PerformanceObserverEntryList");
var Performance = class {
  __unenv__ = true;
  timeOrigin = _timeOrigin;
  eventCounts = /* @__PURE__ */ new Map();
  _entries = [];
  _resourceTimingBufferSize = 0;
  navigation = void 0;
  timing = void 0;
  timerify(_fn, _options) {
    throw createNotImplementedError("Performance.timerify");
  }
  get nodeTiming() {
    return nodeTiming;
  }
  eventLoopUtilization() {
    return {};
  }
  markResourceTiming() {
    return new PerformanceResourceTiming("");
  }
  onresourcetimingbufferfull = null;
  now() {
    if (this.timeOrigin === _timeOrigin) {
      return _performanceNow();
    }
    return Date.now() - this.timeOrigin;
  }
  clearMarks(markName) {
    this._entries = markName ? this._entries.filter((e) => e.name !== markName) : this._entries.filter((e) => e.entryType !== "mark");
  }
  clearMeasures(measureName) {
    this._entries = measureName ? this._entries.filter((e) => e.name !== measureName) : this._entries.filter((e) => e.entryType !== "measure");
  }
  clearResourceTimings() {
    this._entries = this._entries.filter((e) => e.entryType !== "resource" || e.entryType !== "navigation");
  }
  getEntries() {
    return this._entries;
  }
  getEntriesByName(name, type) {
    return this._entries.filter((e) => e.name === name && (!type || e.entryType === type));
  }
  getEntriesByType(type) {
    return this._entries.filter((e) => e.entryType === type);
  }
  mark(name, options) {
    const entry = new PerformanceMark(name, options);
    this._entries.push(entry);
    return entry;
  }
  measure(measureName, startOrMeasureOptions, endMark) {
    let start;
    let end;
    if (typeof startOrMeasureOptions === "string") {
      start = this.getEntriesByName(startOrMeasureOptions, "mark")[0]?.startTime;
      end = this.getEntriesByName(endMark, "mark")[0]?.startTime;
    } else {
      start = Number.parseFloat(startOrMeasureOptions?.start) || this.now();
      end = Number.parseFloat(startOrMeasureOptions?.end) || this.now();
    }
    const entry = new PerformanceMeasure(measureName, {
      startTime: start,
      detail: {
        start,
        end
      }
    });
    this._entries.push(entry);
    return entry;
  }
  setResourceTimingBufferSize(maxSize) {
    this._resourceTimingBufferSize = maxSize;
  }
  addEventListener(type, listener, options) {
    throw createNotImplementedError("Performance.addEventListener");
  }
  removeEventListener(type, listener, options) {
    throw createNotImplementedError("Performance.removeEventListener");
  }
  dispatchEvent(event) {
    throw createNotImplementedError("Performance.dispatchEvent");
  }
  toJSON() {
    return this;
  }
};
__name(Performance, "Performance");
var PerformanceObserver = class {
  __unenv__ = true;
  _callback = null;
  constructor(callback) {
    this._callback = callback;
  }
  takeRecords() {
    return [];
  }
  disconnect() {
    throw createNotImplementedError("PerformanceObserver.disconnect");
  }
  observe(options) {
    throw createNotImplementedError("PerformanceObserver.observe");
  }
  bind(fn) {
    return fn;
  }
  runInAsyncScope(fn, thisArg, ...args) {
    return fn.call(thisArg, ...args);
  }
  asyncId() {
    return 0;
  }
  triggerAsyncId() {
    return 0;
  }
  emitDestroy() {
    return this;
  }
};
__name(PerformanceObserver, "PerformanceObserver");
__publicField(PerformanceObserver, "supportedEntryTypes", []);
var performance = globalThis.performance && "addEventListener" in globalThis.performance ? globalThis.performance : new Performance();

// node_modules/@cloudflare/unenv-preset/dist/runtime/polyfill/performance.mjs
globalThis.performance = performance;
globalThis.Performance = Performance;
globalThis.PerformanceEntry = PerformanceEntry;
globalThis.PerformanceMark = PerformanceMark;
globalThis.PerformanceMeasure = PerformanceMeasure;
globalThis.PerformanceObserver = PerformanceObserver;
globalThis.PerformanceObserverEntryList = PerformanceObserverEntryList;
globalThis.PerformanceResourceTiming = PerformanceResourceTiming;

// node_modules/unenv/dist/runtime/node/console.mjs
import { Writable } from "node:stream";

// node_modules/unenv/dist/runtime/mock/noop.mjs
var noop_default = Object.assign(() => {
}, { __unenv__: true });

// node_modules/unenv/dist/runtime/node/console.mjs
var _console = globalThis.console;
var _ignoreErrors = true;
var _stderr = new Writable();
var _stdout = new Writable();
var log = _console?.log ?? noop_default;
var info = _console?.info ?? log;
var trace = _console?.trace ?? info;
var debug = _console?.debug ?? log;
var table = _console?.table ?? log;
var error = _console?.error ?? log;
var warn = _console?.warn ?? error;
var createTask = _console?.createTask ?? /* @__PURE__ */ notImplemented("console.createTask");
var clear = _console?.clear ?? noop_default;
var count = _console?.count ?? noop_default;
var countReset = _console?.countReset ?? noop_default;
var dir = _console?.dir ?? noop_default;
var dirxml = _console?.dirxml ?? noop_default;
var group = _console?.group ?? noop_default;
var groupEnd = _console?.groupEnd ?? noop_default;
var groupCollapsed = _console?.groupCollapsed ?? noop_default;
var profile = _console?.profile ?? noop_default;
var profileEnd = _console?.profileEnd ?? noop_default;
var time = _console?.time ?? noop_default;
var timeEnd = _console?.timeEnd ?? noop_default;
var timeLog = _console?.timeLog ?? noop_default;
var timeStamp = _console?.timeStamp ?? noop_default;
var Console = _console?.Console ?? /* @__PURE__ */ notImplementedClass("console.Console");
var _times = /* @__PURE__ */ new Map();
var _stdoutErrorHandler = noop_default;
var _stderrErrorHandler = noop_default;

// node_modules/@cloudflare/unenv-preset/dist/runtime/node/console.mjs
var workerdConsole = globalThis["console"];
var {
  assert,
  clear: clear2,
  // @ts-expect-error undocumented public API
  context,
  count: count2,
  countReset: countReset2,
  // @ts-expect-error undocumented public API
  createTask: createTask2,
  debug: debug2,
  dir: dir2,
  dirxml: dirxml2,
  error: error2,
  group: group2,
  groupCollapsed: groupCollapsed2,
  groupEnd: groupEnd2,
  info: info2,
  log: log2,
  profile: profile2,
  profileEnd: profileEnd2,
  table: table2,
  time: time2,
  timeEnd: timeEnd2,
  timeLog: timeLog2,
  timeStamp: timeStamp2,
  trace: trace2,
  warn: warn2
} = workerdConsole;
Object.assign(workerdConsole, {
  Console,
  _ignoreErrors,
  _stderr,
  _stderrErrorHandler,
  _stdout,
  _stdoutErrorHandler,
  _times
});
var console_default = workerdConsole;

// node_modules/wrangler/_virtual_unenv_global_polyfill-@cloudflare-unenv-preset-node-console
globalThis.console = console_default;

// node_modules/unenv/dist/runtime/node/internal/process/hrtime.mjs
var hrtime = /* @__PURE__ */ Object.assign(/* @__PURE__ */ __name(function hrtime2(startTime) {
  const now = Date.now();
  const seconds = Math.trunc(now / 1e3);
  const nanos = now % 1e3 * 1e6;
  if (startTime) {
    let diffSeconds = seconds - startTime[0];
    let diffNanos = nanos - startTime[0];
    if (diffNanos < 0) {
      diffSeconds = diffSeconds - 1;
      diffNanos = 1e9 + diffNanos;
    }
    return [diffSeconds, diffNanos];
  }
  return [seconds, nanos];
}, "hrtime"), { bigint: /* @__PURE__ */ __name(function bigint() {
  return BigInt(Date.now() * 1e6);
}, "bigint") });

// node_modules/unenv/dist/runtime/node/internal/process/process.mjs
import { EventEmitter } from "node:events";

// node_modules/unenv/dist/runtime/node/internal/tty/read-stream.mjs
import { Socket } from "node:net";
var ReadStream = class extends Socket {
  fd;
  constructor(fd) {
    super();
    this.fd = fd;
  }
  isRaw = false;
  setRawMode(mode) {
    this.isRaw = mode;
    return this;
  }
  isTTY = false;
};
__name(ReadStream, "ReadStream");

// node_modules/unenv/dist/runtime/node/internal/tty/write-stream.mjs
import { Socket as Socket2 } from "node:net";
var WriteStream = class extends Socket2 {
  fd;
  constructor(fd) {
    super();
    this.fd = fd;
  }
  clearLine(dir3, callback) {
    callback && callback();
    return false;
  }
  clearScreenDown(callback) {
    callback && callback();
    return false;
  }
  cursorTo(x, y, callback) {
    callback && typeof callback === "function" && callback();
    return false;
  }
  moveCursor(dx, dy, callback) {
    callback && callback();
    return false;
  }
  getColorDepth(env2) {
    return 1;
  }
  hasColors(count3, env2) {
    return false;
  }
  getWindowSize() {
    return [this.columns, this.rows];
  }
  columns = 80;
  rows = 24;
  isTTY = false;
};
__name(WriteStream, "WriteStream");

// node_modules/unenv/dist/runtime/node/internal/process/process.mjs
var Process = class extends EventEmitter {
  env;
  hrtime;
  nextTick;
  constructor(impl) {
    super();
    this.env = impl.env;
    this.hrtime = impl.hrtime;
    this.nextTick = impl.nextTick;
    for (const prop of [...Object.getOwnPropertyNames(Process.prototype), ...Object.getOwnPropertyNames(EventEmitter.prototype)]) {
      const value = this[prop];
      if (typeof value === "function") {
        this[prop] = value.bind(this);
      }
    }
  }
  emitWarning(warning, type, code) {
    console.warn(`${code ? `[${code}] ` : ""}${type ? `${type}: ` : ""}${warning}`);
  }
  emit(...args) {
    return super.emit(...args);
  }
  listeners(eventName) {
    return super.listeners(eventName);
  }
  #stdin;
  #stdout;
  #stderr;
  get stdin() {
    return this.#stdin ??= new ReadStream(0);
  }
  get stdout() {
    return this.#stdout ??= new WriteStream(1);
  }
  get stderr() {
    return this.#stderr ??= new WriteStream(2);
  }
  #cwd = "/";
  chdir(cwd2) {
    this.#cwd = cwd2;
  }
  cwd() {
    return this.#cwd;
  }
  arch = "";
  platform = "";
  argv = [];
  argv0 = "";
  execArgv = [];
  execPath = "";
  title = "";
  pid = 200;
  ppid = 100;
  get version() {
    return "";
  }
  get versions() {
    return {};
  }
  get allowedNodeEnvironmentFlags() {
    return /* @__PURE__ */ new Set();
  }
  get sourceMapsEnabled() {
    return false;
  }
  get debugPort() {
    return 0;
  }
  get throwDeprecation() {
    return false;
  }
  get traceDeprecation() {
    return false;
  }
  get features() {
    return {};
  }
  get release() {
    return {};
  }
  get connected() {
    return false;
  }
  get config() {
    return {};
  }
  get moduleLoadList() {
    return [];
  }
  constrainedMemory() {
    return 0;
  }
  availableMemory() {
    return 0;
  }
  uptime() {
    return 0;
  }
  resourceUsage() {
    return {};
  }
  ref() {
  }
  unref() {
  }
  umask() {
    throw createNotImplementedError("process.umask");
  }
  getBuiltinModule() {
    return void 0;
  }
  getActiveResourcesInfo() {
    throw createNotImplementedError("process.getActiveResourcesInfo");
  }
  exit() {
    throw createNotImplementedError("process.exit");
  }
  reallyExit() {
    throw createNotImplementedError("process.reallyExit");
  }
  kill() {
    throw createNotImplementedError("process.kill");
  }
  abort() {
    throw createNotImplementedError("process.abort");
  }
  dlopen() {
    throw createNotImplementedError("process.dlopen");
  }
  setSourceMapsEnabled() {
    throw createNotImplementedError("process.setSourceMapsEnabled");
  }
  loadEnvFile() {
    throw createNotImplementedError("process.loadEnvFile");
  }
  disconnect() {
    throw createNotImplementedError("process.disconnect");
  }
  cpuUsage() {
    throw createNotImplementedError("process.cpuUsage");
  }
  setUncaughtExceptionCaptureCallback() {
    throw createNotImplementedError("process.setUncaughtExceptionCaptureCallback");
  }
  hasUncaughtExceptionCaptureCallback() {
    throw createNotImplementedError("process.hasUncaughtExceptionCaptureCallback");
  }
  initgroups() {
    throw createNotImplementedError("process.initgroups");
  }
  openStdin() {
    throw createNotImplementedError("process.openStdin");
  }
  assert() {
    throw createNotImplementedError("process.assert");
  }
  binding() {
    throw createNotImplementedError("process.binding");
  }
  permission = { has: /* @__PURE__ */ notImplemented("process.permission.has") };
  report = {
    directory: "",
    filename: "",
    signal: "SIGUSR2",
    compact: false,
    reportOnFatalError: false,
    reportOnSignal: false,
    reportOnUncaughtException: false,
    getReport: /* @__PURE__ */ notImplemented("process.report.getReport"),
    writeReport: /* @__PURE__ */ notImplemented("process.report.writeReport")
  };
  finalization = {
    register: /* @__PURE__ */ notImplemented("process.finalization.register"),
    unregister: /* @__PURE__ */ notImplemented("process.finalization.unregister"),
    registerBeforeExit: /* @__PURE__ */ notImplemented("process.finalization.registerBeforeExit")
  };
  memoryUsage = Object.assign(() => ({
    arrayBuffers: 0,
    rss: 0,
    external: 0,
    heapTotal: 0,
    heapUsed: 0
  }), { rss: () => 0 });
  mainModule = void 0;
  domain = void 0;
  send = void 0;
  exitCode = void 0;
  channel = void 0;
  getegid = void 0;
  geteuid = void 0;
  getgid = void 0;
  getgroups = void 0;
  getuid = void 0;
  setegid = void 0;
  seteuid = void 0;
  setgid = void 0;
  setgroups = void 0;
  setuid = void 0;
  _events = void 0;
  _eventsCount = void 0;
  _exiting = void 0;
  _maxListeners = void 0;
  _debugEnd = void 0;
  _debugProcess = void 0;
  _fatalException = void 0;
  _getActiveHandles = void 0;
  _getActiveRequests = void 0;
  _kill = void 0;
  _preload_modules = void 0;
  _rawDebug = void 0;
  _startProfilerIdleNotifier = void 0;
  _stopProfilerIdleNotifier = void 0;
  _tickCallback = void 0;
  _disconnect = void 0;
  _handleQueue = void 0;
  _pendingMessage = void 0;
  _channel = void 0;
  _send = void 0;
  _linkedBinding = void 0;
};
__name(Process, "Process");

// node_modules/@cloudflare/unenv-preset/dist/runtime/node/process.mjs
var globalProcess = globalThis["process"];
var getBuiltinModule = globalProcess.getBuiltinModule;
var { exit, platform, nextTick } = getBuiltinModule(
  "node:process"
);
var unenvProcess = new Process({
  env: globalProcess.env,
  hrtime,
  nextTick
});
var {
  abort,
  addListener,
  allowedNodeEnvironmentFlags,
  hasUncaughtExceptionCaptureCallback,
  setUncaughtExceptionCaptureCallback,
  loadEnvFile,
  sourceMapsEnabled,
  arch,
  argv,
  argv0,
  chdir,
  config,
  connected,
  constrainedMemory,
  availableMemory,
  cpuUsage,
  cwd,
  debugPort,
  dlopen,
  disconnect,
  emit,
  emitWarning,
  env,
  eventNames,
  execArgv,
  execPath,
  finalization,
  features,
  getActiveResourcesInfo,
  getMaxListeners,
  hrtime: hrtime3,
  kill,
  listeners,
  listenerCount,
  memoryUsage,
  on,
  off,
  once,
  pid,
  ppid,
  prependListener,
  prependOnceListener,
  rawListeners,
  release,
  removeAllListeners,
  removeListener,
  report,
  resourceUsage,
  setMaxListeners,
  setSourceMapsEnabled,
  stderr,
  stdin,
  stdout,
  title,
  throwDeprecation,
  traceDeprecation,
  umask,
  uptime,
  version,
  versions,
  domain,
  initgroups,
  moduleLoadList,
  reallyExit,
  openStdin,
  assert: assert2,
  binding,
  send,
  exitCode,
  channel,
  getegid,
  geteuid,
  getgid,
  getgroups,
  getuid,
  setegid,
  seteuid,
  setgid,
  setgroups,
  setuid,
  permission,
  mainModule,
  _events,
  _eventsCount,
  _exiting,
  _maxListeners,
  _debugEnd,
  _debugProcess,
  _fatalException,
  _getActiveHandles,
  _getActiveRequests,
  _kill,
  _preload_modules,
  _rawDebug,
  _startProfilerIdleNotifier,
  _stopProfilerIdleNotifier,
  _tickCallback,
  _disconnect,
  _handleQueue,
  _pendingMessage,
  _channel,
  _send,
  _linkedBinding
} = unenvProcess;
var _process = {
  abort,
  addListener,
  allowedNodeEnvironmentFlags,
  hasUncaughtExceptionCaptureCallback,
  setUncaughtExceptionCaptureCallback,
  loadEnvFile,
  sourceMapsEnabled,
  arch,
  argv,
  argv0,
  chdir,
  config,
  connected,
  constrainedMemory,
  availableMemory,
  cpuUsage,
  cwd,
  debugPort,
  dlopen,
  disconnect,
  emit,
  emitWarning,
  env,
  eventNames,
  execArgv,
  execPath,
  exit,
  finalization,
  features,
  getBuiltinModule,
  getActiveResourcesInfo,
  getMaxListeners,
  hrtime: hrtime3,
  kill,
  listeners,
  listenerCount,
  memoryUsage,
  nextTick,
  on,
  off,
  once,
  pid,
  platform,
  ppid,
  prependListener,
  prependOnceListener,
  rawListeners,
  release,
  removeAllListeners,
  removeListener,
  report,
  resourceUsage,
  setMaxListeners,
  setSourceMapsEnabled,
  stderr,
  stdin,
  stdout,
  title,
  throwDeprecation,
  traceDeprecation,
  umask,
  uptime,
  version,
  versions,
  // @ts-expect-error old API
  domain,
  initgroups,
  moduleLoadList,
  reallyExit,
  openStdin,
  assert: assert2,
  binding,
  send,
  exitCode,
  channel,
  getegid,
  geteuid,
  getgid,
  getgroups,
  getuid,
  setegid,
  seteuid,
  setgid,
  setgroups,
  setuid,
  permission,
  mainModule,
  _events,
  _eventsCount,
  _exiting,
  _maxListeners,
  _debugEnd,
  _debugProcess,
  _fatalException,
  _getActiveHandles,
  _getActiveRequests,
  _kill,
  _preload_modules,
  _rawDebug,
  _startProfilerIdleNotifier,
  _stopProfilerIdleNotifier,
  _tickCallback,
  _disconnect,
  _handleQueue,
  _pendingMessage,
  _channel,
  _send,
  _linkedBinding
};
var process_default = _process;

// node_modules/wrangler/_virtual_unenv_global_polyfill-@cloudflare-unenv-preset-node-process
globalThis.process = process_default;

// ../src/lib/translator/translation-core.ts
var MODEL_OUTPUT_LIMITS = {
  // Gemini text models - all verified at 65,536 output tokens.
  "gemini-2.5-flash": 65536,
  "gemini-2.5-flash-lite": 65536,
  "gemini-2.5-pro": 65536,
  "gemini-3.1-pro-preview": 65536,
  "gemini-3.1-flash-lite": 65536,
  "gemini-3.5-flash": 65536,
  "gemini-3.5-flash-lite": 65536,
  "gemini-3.6-flash": 65536,
  "gemini-3.7-flash": 65536,
  "gemini-3.8-flash": 65536,
  // OpenRouter free cascade - per-model caps from the OpenRouter catalog.
  "inclusionai/ling-3.0-flash-fin:free": 32768,
  "inclusionai/ling-3.0-flash-sante:free": 32768,
  "google/gemma-4-31b-it:free": 32768,
  "google/gemma-4-26b-a4b-it:free": 32768,
  "poolside/laguna-s-2.1:free": 32768,
  "poolside/laguna-xs-2.1:free": 32768,
  "nex-agi/nex-n2.5-pro:free": 235929,
  "nex-agi/nex-n2.5-mini:free": 235929,
  "nvidia/nemotron-3-ultra-550b-a55b:free": 65536,
  "thinkingmachines/inkling:free": 262144,
  "nvidia/nemotron-3.5-lightning:free": 65536,
  "thinkingmachines/inkling-small:free": 262144,
  "dots-studio/dots-3-note-preview:free": 460800,
  "nvidia/nemotron-3-super-120b-a12b:free": 235929,
  "liquid/lfm-2.5-2.6b:free": 8192
};
var REQUEST_CAP = 65536;
var DEFAULT_BUDGET = 8192;
function normalizeModelName(model) {
  const bare = model.includes("/") ? model.split("/").pop() ?? model : model;
  return bare.toLowerCase().trim();
}
__name(normalizeModelName, "normalizeModelName");
function requestedMaxTokens(model) {
  const exact = MODEL_OUTPUT_LIMITS[model.toLowerCase().trim()];
  if (exact !== void 0)
    return Math.min(exact, REQUEST_CAP);
  const bare = MODEL_OUTPUT_LIMITS[normalizeModelName(model)];
  if (bare === void 0)
    return DEFAULT_BUDGET;
  return Math.min(bare, REQUEST_CAP);
}
__name(requestedMaxTokens, "requestedMaxTokens");
var PROVIDER_BLOCK_RE = /SAFETY|PROHIBITED_CONTENT|BLOCKLIST|RECITATION|SPII|content filter|content_filter|moderation/i;
function classifyGeminiResponse(data, model) {
  const d = data;
  const pf = d?.promptFeedback;
  if (pf?.blockReason) {
    return { kind: "BLOCKED", reason: `prompt blocked: ${pf.blockReason}` };
  }
  const err = d?.error;
  if (err) {
    const msg = String(err.message ?? "");
    if (err.code === 429)
      return { kind: "RATE_LIMITED" };
    if (PROVIDER_BLOCK_RE.test(msg))
      return { kind: "BLOCKED", reason: msg.slice(0, 300) };
    return { kind: "TRANSIENT", reason: `MODEL_ERROR: ${msg.slice(0, 300)}` };
  }
  const cand = d?.candidates?.[0];
  const text = extractGeminiText(d);
  const fr = cand?.finishReason;
  if (!text) {
    if (fr && fr !== "STOP" && fr !== "MAX_TOKENS") {
      return { kind: "BLOCKED", reason: `finishReason=${fr}` };
    }
    return { kind: "TRANSIENT", reason: fr === "MAX_TOKENS" ? "empty MAX_TOKENS response" : "empty response" };
  }
  if (fr === "MAX_TOKENS")
    return { kind: "TRUNCATED", content: text, model };
  return { kind: "SUCCESS", content: text, model };
}
__name(classifyGeminiResponse, "classifyGeminiResponse");
function classifyOpenRouterResponse(data, model, httpStatus) {
  const d = data;
  if (httpStatus === 429)
    return { kind: "RATE_LIMITED" };
  if (httpStatus === 402 || httpStatus === 404 || httpStatus === 408) {
    return { kind: "TRANSIENT", reason: `model unavailable (HTTP ${httpStatus})` };
  }
  const choice = d?.choices?.[0];
  const content = choice?.message?.content;
  if (!content) {
    const e = String(d?.error?.message ?? "");
    if (PROVIDER_BLOCK_RE.test(e))
      return { kind: "BLOCKED", reason: e.slice(0, 300) };
    return { kind: "TRANSIENT", reason: "empty response" };
  }
  if (choice?.finish_reason === "length")
    return { kind: "TRUNCATED", content, model };
  return { kind: "SUCCESS", content, model };
}
__name(classifyOpenRouterResponse, "classifyOpenRouterResponse");
function extractGeminiText(data) {
  const d = data;
  const parts = d?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const texts = parts.map((p) => p?.text).filter((t) => typeof t === "string" && t.length > 0);
    if (texts.length > 0)
      return texts.join("");
  }
  return null;
}
__name(extractGeminiText, "extractGeminiText");
var CJK_RE = /[\u4e00-\u9fff]/;
function paraTokens(s) {
  const out = /* @__PURE__ */ new Set();
  const clean = s.toLowerCase();
  const unigrams = clean.match(/[a-z0-9]+|[\u4e00-\u9fff]/g) ?? [];
  for (let i = 0; i < unigrams.length; i++) {
    out.add(unigrams[i]);
    if (CJK_RE.test(unigrams[i]) && i + 1 < unigrams.length && CJK_RE.test(unigrams[i + 1])) {
      out.add(unigrams[i] + unigrams[i + 1]);
    }
  }
  return out;
}
__name(paraTokens, "paraTokens");
function normalizeText(s) {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
__name(normalizeText, "normalizeText");
function similarity(a, b) {
  const A = paraTokens(a);
  const B = paraTokens(b);
  if (A.size === 0 && B.size === 0)
    return 1;
  let inter = 0;
  for (const t of A)
    if (B.has(t))
      inter++;
  return inter / (A.size + B.size - inter);
}
__name(similarity, "similarity");
function countParagraphs(text) {
  return text.split(/\n+/).filter((p) => p.trim().length > 0).length;
}
__name(countParagraphs, "countParagraphs");
var COVERED_RATIO = 0.6;
var EXPANSION_MIN = 0.25;
var EXPANSION_MAX = 5;
function computeResumeBoundary(sourceParagraphs, accumulatedTranslation) {
  const srcCount = sourceParagraphs.length;
  const charOffsetOf = /* @__PURE__ */ __name((idx) => {
    let off2 = 0;
    for (let k = 0; k < idx && k < srcCount; k++)
      off2 += sourceParagraphs[k].length + 1;
    return off2;
  }, "charOffsetOf");
  const accBag = paraTokens(accumulatedTranslation);
  let i = 0;
  let covered = 0;
  while (i < srcCount) {
    const bag = paraTokens(sourceParagraphs[i]);
    if (bag.size === 0) {
      i++;
      covered++;
      continue;
    }
    let hits = 0;
    for (const t of bag)
      if (accBag.has(t))
        hits++;
    if (hits / bag.size >= COVERED_RATIO) {
      i++;
      covered++;
      continue;
    }
    break;
  }
  let contradiction = false;
  for (let j = i + 1; j < srcCount; j++) {
    const bag = paraTokens(sourceParagraphs[j]);
    if (bag.size === 0)
      continue;
    let hits = 0;
    for (const t of bag)
      if (accBag.has(t))
        hits++;
    if (hits / bag.size >= COVERED_RATIO) {
      contradiction = true;
      break;
    }
  }
  if (!contradiction && covered > 0 && i < srcCount && accBag.size > 0) {
    return {
      paraIndex: i,
      charOffset: charOffsetOf(i),
      coveredParagraphs: covered,
      confident: true,
      which: "token-overlap"
    };
  }
  const accParas = countParagraphs(accumulatedTranslation);
  if (accParas > 0 && accParas < srcCount) {
    const accAvg = accumulatedTranslation.trim().length / accParas;
    const srcPrefix = sourceParagraphs.slice(0, accParas).join("\n");
    const srcAvg = Math.max(1, srcPrefix.length / accParas);
    const expansion = accAvg / srcAvg;
    const plausible = expansion >= EXPANSION_MIN && expansion <= EXPANSION_MAX;
    return {
      paraIndex: accParas,
      charOffset: charOffsetOf(accParas),
      coveredParagraphs: accParas,
      confident: plausible,
      which: "paragraph-count"
    };
  }
  return { paraIndex: 0, charOffset: 0, coveredParagraphs: 0, confident: false, which: "none" };
}
__name(computeResumeBoundary, "computeResumeBoundary");
function joinContinuation(accumulated, continuation, sentSourceRegion) {
  const contNorm = normalizeText(continuation);
  const accNorm = normalizeText(accumulated);
  if (contNorm.length >= 40 && similarity(contNorm.slice(0, 200), accNorm.slice(0, 200)) > 0.8) {
    return { ok: false, joined: accumulated, reason: "restart" };
  }
  const contTokens = paraTokens(continuation);
  if (sentSourceRegion.trim().length > 0 && contTokens.size >= 10) {
    if (similarity(continuation, sentSourceRegion) > 0.5) {
      return { ok: false, joined: accumulated, reason: "echo" };
    }
  }
  let rawStrip = 0;
  const accRawTail = accumulated.slice(-400);
  for (let n = Math.min(accRawTail.length, continuation.length); n >= 8; n--) {
    if (accRawTail.endsWith(continuation.slice(0, n))) {
      rawStrip = n;
      break;
    }
  }
  let cont = continuation.slice(rawStrip);
  let stripped = rawStrip > 0;
  if (!stripped && contNorm.length > 0 && accNorm.length > 0) {
    const accTailNorm = accNorm.slice(-300);
    let normStrip = 0;
    for (let n = Math.min(accTailNorm.length, contNorm.length); n >= 12; n--) {
      if (accTailNorm.endsWith(contNorm.slice(0, n))) {
        normStrip = n;
        break;
      }
    }
    if (normStrip > 0) {
      const firstKeep = contNorm.slice(normStrip).trimStart().split(" ")[0];
      if (firstKeep) {
        const idx = continuation.indexOf(firstKeep);
        if (idx > 0) {
          cont = continuation.slice(idx);
          stripped = true;
        }
      }
    }
  }
  let joiner;
  if (stripped) {
    joiner = /\s$/.test(accumulated) || /^\s/.test(cont) ? "" : " ";
  } else {
    const accEndsClean = /[.!?…]["'」』”’]?\s*$/.test(accumulated);
    const contStartsLower = /^[a-z]/.test(cont.trimStart());
    joiner = accEndsClean && !contStartsLower ? "\n\n" : " ";
  }
  return { ok: true, joined: (accumulated + joiner + cont).trim() };
}
__name(joinContinuation, "joinContinuation");
var GATE = {
  maxCjkRatio: 0.1,
  maxSourceSim: 0.9,
  minLenRatio: 0.35,
  minParaRatio: 0.5
};
function validateTranslation(translated, source) {
  const t = translated.trim();
  const srcLen = Math.max(1, source.length);
  const srcParas = countParagraphs(source);
  if (!t)
    return { passed: false, reason: "empty", cjkRatio: 1, lengthRatio: 0, paraRatio: 0 };
  if (similarity(t, source) >= GATE.maxSourceSim) {
    return { passed: false, reason: "identical-to-source", cjkRatio: 1, lengthRatio: t.length / srcLen, paraRatio: 0 };
  }
  const cjk = (t.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const cjkRatio = t.length > 0 ? cjk / t.length : 1;
  if (cjkRatio > GATE.maxCjkRatio) {
    return { passed: false, reason: "mostly-chinese", cjkRatio, lengthRatio: t.length / srcLen, paraRatio: 0 };
  }
  const lengthRatio = t.length / srcLen;
  if (lengthRatio < GATE.minLenRatio) {
    return { passed: false, reason: "too-short", cjkRatio, lengthRatio, paraRatio: 0 };
  }
  const outParas = countParagraphs(t);
  const paraRatio = srcParas > 0 ? outParas / srcParas : 1;
  if (paraRatio < GATE.minParaRatio) {
    return { passed: false, reason: "missing-paragraphs", cjkRatio, lengthRatio, paraRatio };
  }
  return { passed: true, cjkRatio, lengthRatio, paraRatio };
}
__name(validateTranslation, "validateTranslation");

// src/worker.ts
var SYSTEM_PROMPT = `You are an expert human literary translator specializing in Chinese web novels (Xianxia, Wuxia, and Sci-Fi). Translate the following Chinese prose into highly fluent, immersive English fiction. Do not use stiff or literal machine-like phrasing. Translate cultivation tiers, localized idioms, and online slang into contextually accurate Western fantasy equivalents while maintaining rigid character name consistency.

## FORMATTING RULES (VERY IMPORTANT - FOLLOW EXACTLY):

You MUST separate EVERY paragraph with a BLANK LINE. This means each paragraph ends with TWO newline characters. This is non-negotiable.

- Count the paragraphs in the input. Your output MUST have the SAME number of paragraphs.
- Each paragraph in the input becomes exactly ONE paragraph in the output, separated by a blank line.
- Preserve dialogue formatting and paragraph indentation style.
- Do NOT merge paragraphs together.
- Do NOT output everything as one continuous block of text.

## OUTPUT RULES:
- Output ONLY the translated English text.
- Do NOT include any explanations, notes, commentary, or metadata.
- Do NOT wrap your output in quotes or markdown code blocks.
- Just return the raw translated English prose with proper paragraph spacing.
- CRITICAL: Do NOT leave ANY Chinese characters untranslated. Every single Chinese word, phrase, and sentence MUST be translated to English.`;
var CONTINUATION_PROMPT = `You are continuing a Chinese-to-English literary translation that was cut off by an output limit. You will receive the tail of the translation produced so far (CONTEXT ONLY) and the remaining untranslated source text.

## CONTINUATION RULES (CRITICAL):
- Translate the REMAINING SOURCE ONLY, continuing EXACTLY where the translated context ends.
- Do NOT repeat any previously translated text.
- Do NOT restart the translation from the beginning.
- Do NOT skip any source text. Start mid-sentence if that is where the context ends.
- Separate every paragraph with a blank line, matching the source paragraph structure.
- Output ONLY the continuing English prose. No commentary.`;
var AUTO_FREE_MODELS = [
  "inclusionai/ling-3.0-flash-fin:free",
  "inclusionai/ling-3.0-flash-sante:free",
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "poolside/laguna-s-2.1:free",
  "poolside/laguna-xs-2.1:free",
  "nex-agi/nex-n2.5-pro:free",
  "nex-agi/nex-n2.5-mini:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "thinkingmachines/inkling:free",
  "nvidia/nemotron-3.5-lightning:free",
  "thinkingmachines/inkling-small:free",
  "dots-studio/dots-3-note-preview:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "liquid/lfm-2.5-2.6b:free"
];
var BATCH_SIZE = 1;
var MAX_RETRIES = 3;
var STAGGER_MS = 4500;
var MAX_CONTINUATION_ROUNDS = 3;
var MAX_TOTAL_ATTEMPTS = 8;
var UPSTREAM_TIMEOUT_MS = 11e4;
var STALE_TRANSLATING_MS = 20 * 6e4;
var SMOKE_STALE_TRANSLATING_MS = 9e4;
var GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,x-job-secret"
    }
  });
}
__name(json, "json");
function cors() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,x-job-secret"
    }
  });
}
__name(cors, "cors");
function verifySecret(request, env2) {
  if (!env2.JOB_SECRET)
    return true;
  const provided = request.headers.get("x-job-secret") ?? "";
  return provided === env2.JOB_SECRET;
}
__name(verifySecret, "verifySecret");
async function decompressGzip(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i);
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done)
      break;
    chunks.push(value);
  }
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(result);
}
__name(decompressGzip, "decompressGzip");
async function sendTelegram(botToken, chatId, message) {
  if (!botToken || !chatId)
    return;
  const targets = chatId.split(",").map((s) => s.trim()).filter(Boolean);
  await Promise.all(
    targets.map(
      (id) => fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: id,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: true
        })
      }).catch(() => void 0)
    )
  );
}
__name(sendTelegram, "sendTelegram");
function resolveModel(_requested) {
  return AUTO_FREE_MODELS[0];
}
__name(resolveModel, "resolveModel");
function isGeminiModel(model) {
  return model.startsWith("gemini-");
}
__name(isGeminiModel, "isGeminiModel");
var schemaReady = false;
async function ensureSchema(env2) {
  if (schemaReady)
    return;
  const alters = [
    `ALTER TABLE chunks ADD COLUMN original_chunk_id INTEGER`,
    `ALTER TABLE chunks ADD COLUMN part_index INTEGER`,
    `ALTER TABLE chunks ADD COLUMN part_count INTEGER`,
    `ALTER TABLE jobs ADD COLUMN original_count INTEGER`,
    `ALTER TABLE jobs ADD COLUMN smoke_max_tokens INTEGER`
  ];
  for (const sql of alters) {
    try {
      await env2.DB.prepare(sql).run();
    } catch {
    }
  }
  await env2.DB.prepare(
    `CREATE TABLE IF NOT EXISTS legacy_upload_plan (
       job_id TEXT NOT NULL,
       original_id INTEGER NOT NULL,
       parts INTEGER NOT NULL,
       imported_at INTEGER NOT NULL,
       PRIMARY KEY (job_id, original_id)
     )`
  ).run();
  schemaReady = true;
}
__name(ensureSchema, "ensureSchema");
async function callGemini(text, key, model, systemPrompt, maxOutputTokens, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${GEMINI_BASE}/${model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // AQ. keys MUST go in the header — query-param auth is forbidden.
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens
        },
        systemInstruction: { parts: [{ text: systemPrompt }] }
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      if (res.status === 429)
        return { kind: "RATE_LIMITED" };
      const low = errBody.toLowerCase();
      if (res.status === 401 || res.status === 403 || /api[ _-]?key|invalid|expired|unauthorized|credential|permission|forbidden|denied|authentication|access denied|no access/i.test(low)) {
        return {
          kind: "KEY_REJECTED",
          reason: `key \u2026${key.slice(-4)}: ${errBody.slice(0, 200) || "Invalid or expired API key"}`
        };
      }
      if (res.status === 400 && /SAFETY|PROHIBITED_CONTENT|BLOCKLIST|RECITATION|SPII/i.test(errBody)) {
        return { kind: "BLOCKED", reason: errBody.slice(0, 300) };
      }
      return { kind: "TRANSIENT", reason: `HTTP ${res.status}: ${errBody.slice(0, 300)}` };
    }
    const data = await res.json().catch(() => null);
    if (!data)
      return { kind: "TRANSIENT", reason: "invalid JSON response" };
    return classifyGeminiResponse(data, model);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort"))
      return { kind: "TRANSIENT", reason: "upstream timeout" };
    return { kind: "TRANSIENT", reason: msg.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}
__name(callGemini, "callGemini");
async function callOpenRouter(text, key, model, systemPrompt, maxTokens, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://novel-translator.app",
        "X-Title": "Novel Translator"
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text }
        ],
        max_tokens: maxTokens,
        temperature: 0.3
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      if (res.status === 429)
        return { kind: "RATE_LIMITED" };
      if (res.status === 402 || res.status === 404 || res.status === 408) {
        return { kind: "TRANSIENT", reason: `model unavailable (HTTP ${res.status})` };
      }
      const low = errBody.toLowerCase();
      if (res.status === 401 || res.status === 403 && /api[ _-]?key|invalid|expired|unauthorized|credential|authentication/i.test(low)) {
        return { kind: "KEY_REJECTED", reason: `key \u2026${key.slice(-4)}: ${errBody.slice(0, 200)}` };
      }
      if (/content filter|content_filter|moderation policy|flagged/i.test(low)) {
        return { kind: "BLOCKED", reason: errBody.slice(0, 300) };
      }
      return { kind: "TRANSIENT", reason: `HTTP ${res.status}: ${errBody.slice(0, 300)}` };
    }
    const data = await res.json().catch(() => null);
    if (!data)
      return { kind: "TRANSIENT", reason: "invalid JSON response" };
    return classifyOpenRouterResponse(data, model, res.status);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort"))
      return { kind: "TRANSIENT", reason: "upstream timeout" };
    return { kind: "TRANSIENT", reason: msg.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}
__name(callOpenRouter, "callOpenRouter");
function buildContinuationMessage(accumulated, remainingSource) {
  const accParas = accumulated.split(/\n+/).filter((p) => p.trim().length > 0);
  const tail = accParas.slice(-2).join("\n\n");
  return `[TRANSLATED SO FAR \u2014 CONTEXT ONLY. Do NOT repeat or restart this.]
${tail}

[REMAINING SOURCE \u2014 translate ALL of it now, starting exactly where the context above ends]
${remainingSource}`;
}
__name(buildContinuationMessage, "buildContinuationMessage");
async function translateWithContinuation(source, keys, model, liveModels, priorAccumulated = "", budgetOverride) {
  const backend = isGeminiModel(model) ? callGemini : callOpenRouter;
  const budget = budgetOverride && budgetOverride > 0 ? Math.min(budgetOverride, requestedMaxTokens(model)) : requestedMaxTokens(model);
  let accumulated = priorAccumulated;
  let firstRound = priorAccumulated.length === 0;
  for (let round = 0; round <= MAX_CONTINUATION_ROUNDS; round++) {
    let promptText;
    let sentSourceRegion = "";
    if (firstRound) {
      promptText = source;
    } else {
      const srcParas = source.split(/\n+/).filter((p) => p.trim().length > 0);
      const boundary = computeResumeBoundary(srcParas, accumulated);
      if (boundary.confident) {
        const joined = srcParas.join("\n");
        sentSourceRegion = joined.slice(boundary.charOffset);
        if (sentSourceRegion.trim().length === 0) {
          sentSourceRegion = joined;
        }
        promptText = buildContinuationMessage(accumulated, sentSourceRegion);
      } else {
        sentSourceRegion = source;
        promptText = `[TRANSLATED SO FAR \u2014 CONTEXT ONLY. It is INCOMPLETE. Do NOT repeat or restart.]
${accumulated.slice(-1200)}

[FULL SOURCE \u2014 the translation above is MISSING its ending and possibly more. Output ONLY the missing continuation, starting exactly where the context stops mid-flow.]`;
      }
      if (round > MAX_CONTINUATION_ROUNDS - 1)
        break;
    }
    let outcome = null;
    for (const key of keys) {
      outcome = isGeminiModel(model) ? await backend(promptText, key, model, firstRound ? SYSTEM_PROMPT : CONTINUATION_PROMPT, budget) : await backend(promptText, key, model, firstRound ? SYSTEM_PROMPT : CONTINUATION_PROMPT, budget);
      if (outcome.kind === "RATE_LIMITED")
        continue;
      if (outcome.kind === "KEY_REJECTED")
        continue;
      break;
    }
    if (!outcome) {
      return { translated: accumulated, model, truncated: accumulated.length > 0, rateLimited: true };
    }
    if (outcome.kind === "RATE_LIMITED") {
      return { translated: accumulated, model, truncated: accumulated.length > 0, rateLimited: true };
    }
    if (outcome.kind === "KEY_REJECTED") {
      return { translated: accumulated, model, truncated: accumulated.length > 0, keyRejected: outcome.reason };
    }
    if (outcome.kind === "BLOCKED") {
      return { translated: accumulated, model, truncated: false, blockedReason: outcome.reason };
    }
    if (outcome.kind === "TRANSIENT") {
      if (firstRound)
        return { translated: "", model, truncated: false, transient: outcome.reason };
      return { translated: accumulated, model, truncated: true, transient: outcome.reason };
    }
    const piece = outcome.content;
    if (firstRound) {
      accumulated = piece;
      firstRound = false;
      const v2 = validateTranslation(accumulated, source);
      if (v2.passed) {
        return { translated: accumulated, model, truncated: false };
      }
      if (outcome.kind === "TRUNCATED" || v2.reason === "too-short" || v2.reason === "missing-paragraphs") {
        continue;
      }
      return { translated: accumulated, model, truncated: false, gateReason: v2.reason };
    }
    const join = joinContinuation(accumulated, piece, sentSourceRegion);
    if (!join.ok) {
      const v2 = validateTranslation(accumulated, source);
      return {
        translated: accumulated,
        model,
        truncated: true,
        gateReason: v2.passed ? void 0 : v2.reason
      };
    }
    accumulated = join.joined;
    if (outcome.kind === "SUCCESS") {
      const v2 = validateTranslation(accumulated, source);
      if (v2.passed)
        return { translated: accumulated, model, truncated: false };
      if (round < MAX_CONTINUATION_ROUNDS)
        continue;
      return { translated: accumulated, model, truncated: true, gateReason: v2.reason };
    }
  }
  const v = validateTranslation(accumulated, source);
  return {
    translated: accumulated,
    model,
    truncated: true,
    gateReason: v.passed ? void 0 : v.reason
  };
}
__name(translateWithContinuation, "translateWithContinuation");
async function translateChunk(text, keys, requestedModel, liveModels, priorAccumulated = "", budgetOverride) {
  if (!keys.length) {
    return { translated: "", model: requestedModel, truncated: false, transient: "No API keys provided" };
  }
  let models;
  if (isGeminiModel(requestedModel)) {
    models = [requestedModel];
  } else if (requestedModel === "openrouter/free") {
    models = liveModels && liveModels.length > 0 ? liveModels : [resolveModel(requestedModel), ...AUTO_FREE_MODELS.filter((m) => m !== resolveModel(requestedModel))];
  } else {
    models = [requestedModel, ...AUTO_FREE_MODELS.filter((m) => m !== requestedModel)];
  }
  let last = null;
  let allRateLimited = true;
  for (const model of models) {
    const result = await translateWithContinuation(text, keys, model, liveModels, priorAccumulated, budgetOverride);
    if (result.blockedReason)
      return result;
    if (!result.rateLimited && !result.keyRejected && !result.transient) {
      const usable = result.truncated ? result.translated.length > 0 : true;
      if (usable)
        return result;
    }
    last = result;
    if (result.rateLimited) {
      continue;
    }
    allRateLimited = false;
    if (result.keyRejected && keys.length > 1) {
      continue;
    }
    if (!result.truncated || result.translated.length === 0) {
      continue;
    }
    return result;
  }
  if (last)
    return last;
  return {
    translated: priorAccumulated,
    model: requestedModel,
    truncated: priorAccumulated.length > 0,
    transient: "All translation attempts failed",
    rateLimited: allRateLimited || void 0
  };
}
__name(translateChunk, "translateChunk");
async function handleRequest(request, env2) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (method === "OPTIONS")
    return cors();
  await ensureSchema(env2);
  if (path === "/api/ping" && method === "GET") {
    if (!verifySecret(request, env2))
      return json({ error: "Invalid secret" }, 403);
    return json({ ok: true, time: Date.now() });
  }
  if (path === "/api/jobs" && method === "POST") {
    if (!verifySecret(request, env2))
      return json({ error: "Invalid secret" }, 403);
    const body = await request.json();
    if (!body.chunks?.length)
      return json({ error: "No chunks provided" }, 400);
    if (!body.keys?.length)
      return json({ error: "No API keys provided" }, 400);
    const jobId = crypto.randomUUID();
    const now = Date.now();
    const smokeBudget = body.fileName?.startsWith("buffy-smoke-") && Number.isInteger(body.smoke?.forceMaxOutputTokens) && body.smoke?.forceMaxOutputTokens >= 32 ? Math.min(body.smoke.forceMaxOutputTokens, 8192) : null;
    const liveModelsJson = body.liveModels && body.liveModels.length > 0 ? JSON.stringify(body.liveModels) : null;
    await env2.DB.prepare(
      `INSERT INTO jobs (id, file_name, model, keys_json, status, created_at, updated_at, live_models_json, telegram_bot_token, telegram_chat_id, telegram_on_start, telegram_on_progress, telegram_on_error, telegram_on_complete, last_milestone, original_count, smoke_max_tokens)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).bind(
      jobId,
      body.fileName,
      body.model,
      JSON.stringify(body.keys),
      now,
      now,
      liveModelsJson,
      body.telegramBotToken ?? null,
      body.telegramChatId ?? null,
      body.telegramNotifyOnStart ? 1 : 0,
      body.telegramNotifyOnProgress ? 1 : 0,
      body.telegramNotifyOnError ? 1 : 0,
      body.telegramNotifyOnComplete ? 1 : 0,
      body.originalChunkCount ?? body.chunks.length,
      smokeBudget
    ).run();
    const hasMapping = body.chunks.some((c) => c.originalId !== void 0);
    const mappingComplete = body.chunks.every(
      (c) => c.originalId !== void 0 && c.partIndex !== void 0 && c.partCount !== void 0
    );
    if (hasMapping && !mappingComplete) {
      await env2.DB.prepare(`DELETE FROM jobs WHERE id = ?`).bind(jobId).run();
      return json({ error: "Incomplete mapping fields on chunks" }, 400);
    }
    const BATCH = 25;
    for (let i = 0; i < body.chunks.length; i += BATCH) {
      const batch = body.chunks.slice(i, i + BATCH);
      const stmts = await Promise.all(
        batch.map(async (c, idx) => {
          const text = c.gzip ? await decompressGzip(c.text) : c.text;
          return env2.DB.prepare(
            `INSERT INTO chunks (job_id, seq, text, status, attempts, updated_at, original_chunk_id, part_index, part_count)
             VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?)`
          ).bind(
            jobId,
            i + idx,
            text,
            now,
            mappingComplete ? c.originalId : null,
            mappingComplete ? c.partIndex : null,
            mappingComplete ? c.partCount : null
          );
        })
      );
      await env2.DB.batch(stmts);
    }
    if (body.telegramBotToken && body.telegramChatId && body.telegramNotifyOnStart) {
      const sectionCount = body.originalChunkCount ?? body.chunks.length;
      const modelLabel = isGeminiModel(body.model) ? body.model : body.model.split("/").pop()?.replace(/:free$/, "") ?? body.model;
      await sendTelegram(
        body.telegramBotToken,
        body.telegramChatId,
        `\u{1F680} <b>Cloud translation started</b>
\u{1F4DA} ${body.fileName}
\u{1F4E6} ${sectionCount} chunks \u2022 \u2699\uFE0F ${modelLabel}`
      ).catch(() => void 0);
    }
    return json({ jobId, totalChunks: body.chunks.length, mapping: mappingComplete ? "server" : "legacy" });
  }
  const jobMatch = path.match(/^\/api\/jobs\/([a-f0-9-]+)$/);
  if (jobMatch) {
    const jobId = jobMatch[1];
    if (!verifySecret(request, env2))
      return json({ error: "Invalid secret" }, 403);
    if (method === "GET") {
      const job = await env2.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(jobId).first();
      if (!job)
        return json({ error: "Job not found" }, 404);
      const counts = await env2.DB.prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
           SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) as partial,
           SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked
         FROM chunks WHERE job_id = ?`
      ).bind(jobId).first();
      const lastChunk = await env2.DB.prepare(
        `SELECT MAX(updated_at) as last_at FROM chunks WHERE job_id = ? AND status = 'completed'`
      ).bind(jobId).first();
      const mappedCount = await env2.DB.prepare(
        `SELECT COUNT(*) as n FROM chunks WHERE job_id = ? AND original_chunk_id IS NOT NULL`
      ).bind(jobId).first();
      const legacyPlan = await env2.DB.prepare(
        `SELECT COUNT(*) as n FROM legacy_upload_plan WHERE job_id = ?`
      ).bind(jobId).first();
      const totalRows = counts?.total ?? 0;
      const mappedRows = mappedCount?.n ?? 0;
      let mapping;
      if (mappedRows === totalRows && totalRows > 0)
        mapping = "server";
      else if (legacyPlan?.n > 0)
        mapping = "legacy-imported";
      else
        mapping = "legacy-unmapped";
      let pauseReason = null;
      if (job.status === "paused") {
        const failedSample = await env2.DB.prepare(
          `SELECT error FROM chunks WHERE job_id = ? AND status = 'failed' AND (error LIKE '%quota%' OR error = 'Daily free-tier quota exhausted') LIMIT 1`
        ).bind(jobId).first();
        if (failedSample)
          pauseReason = "quota_exhausted";
        else {
          const blockedSample = await env2.DB.prepare(
            `SELECT COUNT(*) as n FROM chunks WHERE job_id = ? AND status = 'blocked'`
          ).bind(jobId).first();
          if (blockedSample?.n > 0)
            pauseReason = "content_blocked";
        }
      }
      return json({
        jobId: job.id,
        fileName: job.file_name,
        status: job.status,
        totalChunks: counts?.total ?? 0,
        completedChunks: counts?.completed ?? 0,
        failedChunks: counts?.failed ?? 0,
        partialChunks: counts?.partial ?? 0,
        blockedChunks: counts?.blocked ?? 0,
        originalCount: job.original_count ?? counts?.total ?? 0,
        mapping,
        activeModel: job.active_model ?? null,
        createdAt: job.created_at,
        lastHeartbeat: job.last_heartbeat,
        lastChunkAt: lastChunk?.last_at ?? null,
        updatedAt: job.updated_at,
        pauseReason
      });
    }
    if (method === "DELETE") {
      await env2.DB.prepare(`DELETE FROM chunks WHERE job_id = ?`).bind(jobId).run();
      await env2.DB.prepare(`DELETE FROM legacy_upload_plan WHERE job_id = ?`).bind(jobId).run();
      await env2.DB.prepare(`DELETE FROM jobs WHERE id = ?`).bind(jobId).run();
      return json({ ok: true });
    }
  }
  const debugMatch = path.match(/^\/api\/jobs\/([a-f0-9-]+)\/debug$/);
  if (debugMatch && method === "GET") {
    const jobId = debugMatch[1];
    if (!verifySecret(request, env2))
      return json({ error: "Invalid secret" }, 403);
    const rows = await env2.DB.prepare(
      `SELECT seq, status, error, model_used, attempts, original_chunk_id, part_index, part_count
       FROM chunks WHERE job_id = ? ORDER BY seq ASC`
    ).bind(jobId).all();
    return json({ chunks: rows.results });
  }
  const chunksMatch = path.match(/^\/api\/jobs\/([a-f0-9-]+)\/chunks$/);
  if (chunksMatch && method === "GET") {
    const jobId = chunksMatch[1];
    if (!verifySecret(request, env2))
      return json({ error: "Invalid secret" }, 403);
    const after = Number(url.searchParams.get("after") ?? "-1");
    const rows = await env2.DB.prepare(
      `SELECT id, seq, translated_text, status, original_chunk_id, part_index, part_count
       FROM chunks
       WHERE job_id = ? AND seq > ? AND status = 'completed' AND translated_text IS NOT NULL
       ORDER BY seq ASC`
    ).bind(jobId, after).all();
    return json({
      chunks: rows.results.map((r) => ({
        id: r.id,
        seq: r.seq,
        text: r.translated_text,
        originalId: r.original_chunk_id,
        partIndex: r.part_index,
        partCount: r.part_count
      }))
    });
  }
  const summaryMatch = path.match(/^\/api\/jobs\/([a-f0-9-]+)\/export-summary$/);
  if (summaryMatch && method === "GET") {
    const jobId = summaryMatch[1];
    if (!verifySecret(request, env2))
      return json({ error: "Invalid secret" }, 403);
    const job = await env2.DB.prepare(`SELECT original_count FROM jobs WHERE id = ?`).bind(jobId).first();
    const rows = await env2.DB.prepare(
      `SELECT original_chunk_id, part_index, part_count, status
       FROM chunks WHERE job_id = ? ORDER BY seq ASC`
    ).bind(jobId).all();
    const byOriginal = /* @__PURE__ */ new Map();
    let unmappedRows = 0;
    for (const r of rows.results) {
      const oid = r.original_chunk_id;
      if (oid === null || oid === void 0) {
        unmappedRows++;
        continue;
      }
      const acc = byOriginal.get(oid) ?? { parts: /* @__PURE__ */ new Set(), expected: r.part_count ?? 1, statuses: [] };
      if (r.status === "completed")
        acc.parts.add(r.part_index ?? 0);
      acc.statuses.push(r.status);
      byOriginal.set(oid, acc);
    }
    const sections = [...byOriginal.entries()].map(([id, acc]) => ({
      id,
      partsCompleted: acc.parts.size,
      partsExpected: acc.expected,
      complete: acc.parts.size >= acc.expected,
      blocked: acc.statuses.includes("blocked"),
      failed: acc.statuses.includes("failed"),
      partial: acc.statuses.includes("partial")
    }));
    const maxId = sections.length > 0 ? Math.max(...sections.map((s) => s.id)) : -1;
    const declared = job?.original_count ?? 0;
    return json({
      mapping: unmappedRows === 0 && sections.length > 0 ? "server" : unmappedRows > 0 && sections.length > 0 ? "mixed" : "legacy-unmapped",
      declaredOriginalCount: declared,
      detectedOriginalCount: sections.length,
      // A declared count larger than detected => some originals have no units
      // visible => legacy/unmapped territory; UI must warn.
      suspiciousGap: declared > 0 && sections.length > 0 && Math.max(0, declared - sections.length) > 0,
      maxSeenId: maxId,
      sections
    });
  }
  const legacyMatch = path.match(/^\/api\/jobs\/([a-f0-9-]+)\/legacy-plan$/);
  if (legacyMatch && method === "POST") {
    const jobId = legacyMatch[1];
    if (!verifySecret(request, env2))
      return json({ error: "Invalid secret" }, 403);
    const body = await request.json();
    const entries = (body.entries ?? []).filter((e) => Number.isInteger(e.originalId) && Number.isInteger(e.parts) && e.parts >= 1);
    if (entries.length === 0)
      return json({ error: "No valid plan entries" }, 400);
    const row = await env2.DB.prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN original_chunk_id IS NOT NULL THEN 1 ELSE 0 END) as mapped
       FROM chunks WHERE job_id = ?`
    ).bind(jobId).first();
    if (!row || row.total === 0)
      return json({ error: "Job not found or has no chunks" }, 404);
    if (row.mapped > 0) {
      return json({ error: "Job already has server-authoritative mapping" }, 409);
    }
    const totalUnits = row.total;
    const planUnits = entries.reduce((s, e) => s + e.parts, 0);
    if (planUnits !== totalUnits) {
      return json({ error: `Plan covers ${planUnits} units but job has ${totalUnits} \u2014 refusing uncertain mapping` }, 422);
    }
    const ids = entries.map((e) => e.originalId).sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] !== i)
        return json({ error: "Plan original ids must be contiguous from 0" }, 422);
    }
    const now = Date.now();
    const stmts = [];
    let seqCursor = 0;
    const unitRows = await env2.DB.prepare(
      `SELECT id FROM chunks WHERE job_id = ? ORDER BY seq ASC`
    ).bind(jobId).all();
    const unitIds = unitRows.results.map((r) => r.id);
    if (unitIds.length !== totalUnits)
      return json({ error: "Chunk rows changed during import \u2014 retry" }, 409);
    for (const e of entries) {
      for (let p = 0; p < e.parts; p++) {
        const unitId = unitIds[seqCursor++];
        stmts.push(
          env2.DB.prepare(
            `UPDATE chunks SET original_chunk_id = ?, part_index = ?, part_count = ? WHERE id = ?`
          ).bind(e.originalId, p, e.parts, unitId)
        );
      }
      stmts.push(
        env2.DB.prepare(
          `INSERT OR REPLACE INTO legacy_upload_plan (job_id, original_id, parts, imported_at) VALUES (?, ?, ?, ?)`
        ).bind(jobId, e.originalId, e.parts, now)
      );
    }
    await env2.DB.batch(stmts);
    return json({ ok: true, mappedUnits: totalUnits, originals: entries.length });
  }
  const retryBlockedMatch = path.match(/^\/api\/jobs\/([a-f0-9-]+)\/retry-blocked$/);
  if (retryBlockedMatch && method === "POST") {
    const jobId = retryBlockedMatch[1];
    if (!verifySecret(request, env2))
      return json({ error: "Invalid secret" }, 403);
    const res = await env2.DB.prepare(
      `UPDATE chunks SET status = 'pending', error = NULL, updated_at = ? WHERE job_id = ? AND status = 'blocked'`
    ).bind(Date.now(), jobId).run();
    await env2.DB.prepare(
      `UPDATE jobs SET status = 'active', updated_at = ? WHERE id = ? AND status = 'paused'`
    ).bind(Date.now(), jobId).run();
    return json({ ok: true, reset: res.meta?.changes ?? 0 });
  }
  if (path === "/api/translate" && method === "POST") {
    if (!verifySecret(request, env2))
      return json({ error: "Invalid secret" }, 403);
    try {
      const body = await request.json();
      if (!body.text)
        return json({ error: "Missing text" }, 400);
      if (!body.keys?.length)
        return json({ error: "No API keys" }, 400);
      const result = await translateChunk(body.text, body.keys, body.model, body.liveModels ?? null);
      if (result.blockedReason) {
        return json({ error: `BLOCKED: ${result.blockedReason}` }, 422);
      }
      return json({ translated: result.translated, model: result.model, truncated: result.truncated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: msg }, 500);
    }
  }
  if (path === "/api/run-cron" && method === "POST") {
    if (!verifySecret(request, env2))
      return json({ error: "Invalid secret" }, 403);
    try {
      await handleCron(env2);
      return json({ ok: true, message: "Cron executed manually" });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }
  const cancelMatch = path.match(/^\/api\/jobs\/([a-f0-9-]+)\/cancel$/);
  if (cancelMatch && method === "POST") {
    const jobId = cancelMatch[1];
    if (!verifySecret(request, env2))
      return json({ error: "Invalid secret" }, 403);
    await env2.DB.prepare(`UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'active'`).bind(Date.now(), jobId).run();
    await env2.DB.prepare(`UPDATE chunks SET status = 'pending' WHERE job_id = ? AND status = 'translating'`).bind(jobId).run();
    return json({ ok: true });
  }
  const smokeStaleMatch = path.match(/^\/api\/jobs\/([a-f0-9-]+)\/smoke-stale$/);
  if (smokeStaleMatch && method === "POST") {
    if (!verifySecret(request, env2))
      return json({ error: "Invalid secret" }, 403);
    const jobId = smokeStaleMatch[1];
    const job = await env2.DB.prepare(`SELECT file_name FROM jobs WHERE id = ?`).bind(jobId).first();
    if (!job)
      return json({ error: "Job not found" }, 404);
    if (!job.file_name.startsWith("buffy-smoke-")) {
      return json({ error: "smoke-stale is only allowed on buffy-smoke-* jobs" }, 403);
    }
    const res = await env2.DB.prepare(
      `UPDATE chunks SET updated_at = ? WHERE job_id = ? AND status = 'translating'`
    ).bind(Date.now() - SMOKE_STALE_TRANSLATING_MS - 1e4, jobId).run();
    return json({ ok: true, rewound: res.meta?.changes ?? 0 });
  }
  return json({ error: "Not found" }, 404);
}
__name(handleRequest, "handleRequest");
async function handleCron(env2) {
  const jobs = await env2.DB.prepare(`SELECT * FROM jobs WHERE status = 'active'`).all();
  for (const job of jobs.results) {
    const jobId = job.id;
    const keys = JSON.parse(job.keys_json ?? "[]");
    const model = job.model;
    const liveModels = job.live_models_json ? JSON.parse(job.live_models_json) : null;
    const telegramToken = job.telegram_bot_token;
    const telegramChatId = job.telegram_chat_id;
    const notifyOnError = job.telegram_on_error === 1;
    const notifyOnComplete = job.telegram_on_complete === 1;
    const notifyOnProgress = job.telegram_on_progress === 1;
    const lastMilestone = job.last_milestone ?? 0;
    if (!keys.length)
      continue;
    await env2.DB.prepare(`UPDATE jobs SET last_heartbeat = ?, updated_at = ? WHERE id = ?`).bind(Date.now(), Date.now(), jobId).run();
    const staleMs = job.file_name?.startsWith("buffy-smoke-") ? SMOKE_STALE_TRANSLATING_MS : STALE_TRANSLATING_MS;
    await env2.DB.prepare(
      `UPDATE chunks
         SET status = CASE WHEN COALESCE(translated_text, '') = '' THEN 'pending' ELSE 'partial' END,
             error = CASE WHEN COALESCE(translated_text, '') = '' THEN error
                          ELSE 'reclaimed from stalled translating \u2014 continuation pending' END,
             updated_at = ?
       WHERE job_id = ? AND status = 'translating' AND updated_at < ?`
    ).bind(Date.now(), jobId, Date.now() - staleMs).run();
    const pending = await env2.DB.prepare(
      `SELECT id, seq, text, translated_text, attempts FROM chunks
       WHERE job_id = ? AND status IN ('pending', 'partial')
       ORDER BY seq ASC
       LIMIT ?`
    ).bind(jobId, BATCH_SIZE).all();
    if (pending.results.length === 0) {
      const currentJob = await env2.DB.prepare(`SELECT status FROM jobs WHERE id = ?`).bind(jobId).first();
      if (currentJob?.status === "paused")
        continue;
      const counts2 = await env2.DB.prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
           SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked
         FROM chunks WHERE job_id = ?`
      ).bind(jobId).first();
      const total = counts2?.total ?? 0;
      const completed = counts2?.completed ?? 0;
      const failed = counts2?.failed ?? 0;
      const blocked = counts2?.blocked ?? 0;
      if (completed + failed + blocked === total && total > 0) {
        await env2.DB.prepare(`UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?`).bind(Date.now(), jobId).run();
        if (telegramToken && telegramChatId && notifyOnComplete) {
          const sectionsDone = await countOriginalSections(env2, jobId, "completed");
          const sectionsBlocked = await countOriginalSections(env2, jobId, "blocked");
          await sendTelegram(
            telegramToken,
            telegramChatId,
            `\u{1F389} <b>Cloud translation complete!</b>
\u2705 ${sectionsDone} sections translated
\u274C ${failed} failed
\u{1F6AB} ${sectionsBlocked} blocked`
          ).catch(() => void 0);
        }
      }
      continue;
    }
    const now = Date.now();
    const claimed = [];
    for (const r of pending.results) {
      const claim = await env2.DB.prepare(
        `UPDATE chunks SET status = 'translating', updated_at = ?
         WHERE id = ? AND status IN ('pending', 'partial')`
      ).bind(now, r.id).run();
      if ((claim.meta?.changes ?? 0) > 0)
        claimed.push(r);
    }
    let completedDelta = 0;
    let failedDelta = 0;
    let blockedDelta = 0;
    let quotaExhausted = false;
    for (let i = 0; i < claimed.length; i++) {
      const chunk = claimed[i];
      const chunkId = chunk.id;
      const seq = chunk.seq;
      const text = chunk.text;
      const priorAccumulated = chunk.translated_text ?? "";
      const currentAttempts = chunk.attempts ?? 0;
      if (i > 0) {
        await new Promise((r) => setTimeout(r, STAGGER_MS));
      }
      try {
        const smokeBudget = job.file_name?.startsWith("buffy-smoke-") ? job.smoke_max_tokens : null;
        const result = await translateChunk(text, keys, model, liveModels, priorAccumulated, smokeBudget);
        const attempts = currentAttempts + 1;
        if (result.blockedReason) {
          await env2.DB.prepare(
            `UPDATE chunks SET status = 'blocked', translated_text = NULL, model_used = ?, error = ?, attempts = ?, updated_at = ? WHERE id = ? AND status = 'translating'`
          ).bind(result.model, `BLOCKED: ${result.blockedReason}`.slice(0, 1e3), attempts, Date.now(), chunkId).run();
          blockedDelta++;
          if (telegramToken && telegramChatId) {
            await sendTelegram(
              telegramToken,
              telegramChatId,
              `\u{1F6AB} <b>Chunk ${seq + 1} blocked by content policy</b>
<code>${result.blockedReason.slice(0, 200)}</code>
Not retried (saves free quota). Use "Retry blocked" in the app if needed.`
            ).catch(() => void 0);
          }
          await env2.DB.prepare(`UPDATE jobs SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'active'`).bind(Date.now(), jobId).run();
          if (telegramToken && telegramChatId) {
            await sendTelegram(
              telegramToken,
              telegramChatId,
              `\u23F8\uFE0F <b>Translation paused \u2014 content blocked</b>
The provider refused to translate this passage. Other chunks are safe.
Open the app to review, or tap "Retry blocked" to continue anyway.`
            ).catch(() => void 0);
          }
          break;
        }
        if (result.rateLimited && result.translated.length === 0) {
          quotaExhausted = true;
          await env2.DB.prepare(
            `UPDATE chunks SET status = 'pending', error = 'Daily free-tier quota exhausted', attempts = ?, updated_at = ? WHERE id = ?`
          ).bind(attempts, Date.now(), chunkId).run();
          await env2.DB.prepare(`UPDATE jobs SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'active'`).bind(Date.now(), jobId).run();
          if (telegramToken && telegramChatId) {
            await sendTelegram(
              telegramToken,
              telegramChatId,
              `\u23F8\uFE0F <b>Translation paused \u2014 daily free quota exhausted</b>
All keys have hit their free daily limit.

\u23F1\uFE0F Resets at midnight UTC \u2014 no action needed, just Resume later.
Nothing was lost; completed chunks are saved.`
            ).catch(() => void 0);
          }
          break;
        }
        if (!result.truncated && result.translated.trim().length > 0) {
          await env2.DB.prepare(
            `UPDATE chunks SET status = 'completed', translated_text = ?, model_used = ?, error = NULL, attempts = ?, updated_at = ? WHERE id = ? AND status = 'translating'`
          ).bind(result.translated, result.model, attempts, Date.now(), chunkId).run();
          completedDelta++;
          await env2.DB.prepare(`UPDATE jobs SET active_model = ?, updated_at = ? WHERE id = ?`).bind(result.model, Date.now(), jobId).run();
          continue;
        }
        if (attempts >= MAX_TOTAL_ATTEMPTS) {
          await env2.DB.prepare(
            `UPDATE chunks SET status = 'failed', translated_text = ?, model_used = ?, error = ?, attempts = ?, updated_at = ? WHERE id = ?`
          ).bind(
            result.translated,
            result.model,
            `Failed after ${attempts} attempts: ${result.gateReason ?? result.keyRejected ?? result.transient ?? "truncation not resolved"}`.slice(0, 1e3),
            attempts,
            Date.now(),
            chunkId
          ).run();
          failedDelta++;
          if (telegramToken && telegramChatId && notifyOnError) {
            await sendTelegram(
              telegramToken,
              telegramChatId,
              `\u274C <b>Chunk ${seq + 1} failed after ${attempts} attempts</b>
<code>${(result.gateReason ?? result.transient ?? "unknown").slice(0, 150)}</code>
Partial text is preserved in storage \u2014 nothing was lost.`
            ).catch(() => void 0);
          }
          continue;
        }
        await env2.DB.prepare(
          `UPDATE chunks SET status = 'partial', translated_text = ?, model_used = ?, error = ?, attempts = ?, updated_at = ? WHERE id = ?`
        ).bind(
          result.translated,
          result.model,
          `partial: ${result.gateReason ?? "truncated \u2014 continuation pending"}`.slice(0, 500),
          attempts,
          Date.now(),
          chunkId
        ).run();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const attempts = currentAttempts + 1;
        if (attempts >= MAX_RETRIES) {
          await env2.DB.prepare(
            `UPDATE chunks SET status = 'failed', error = ?, attempts = ?, updated_at = ? WHERE id = ?`
          ).bind(errMsg.slice(0, 1e3), attempts, Date.now(), chunkId).run();
          failedDelta++;
          if (telegramToken && telegramChatId && notifyOnError) {
            await sendTelegram(
              telegramToken,
              telegramChatId,
              `\u274C <b>Chunk ${seq + 1} failed</b>
<code>${errMsg.slice(0, 150)}</code>`
            ).catch(() => void 0);
          }
        } else {
          await env2.DB.prepare(
            `UPDATE chunks SET status = 'pending', attempts = ?, error = ?, updated_at = ? WHERE id = ?`
          ).bind(attempts, errMsg.slice(0, 500), Date.now(), chunkId).run();
        }
      }
    }
    const counts = await env2.DB.prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
       FROM chunks WHERE job_id = ?`
    ).bind(jobId).first();
    await env2.DB.prepare(
      `UPDATE jobs SET completed_count = ?, failed_count = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?`
    ).bind(
      counts?.completed ?? 0,
      counts?.failed ?? 0,
      Date.now(),
      Date.now(),
      jobId
    ).run();
    if (telegramToken && telegramChatId && notifyOnProgress && counts && !quotaExhausted) {
      const sectionsDone = await countOriginalSections(env2, jobId, "completed");
      const sectionsTotal = job.original_count ?? counts.total ?? 0;
      const pct = sectionsTotal > 0 ? Math.round(sectionsDone / sectionsTotal * 100) : 0;
      const milestone = Math.floor(pct / 25) * 25;
      if (milestone >= lastMilestone + 25 && milestone < 100 && sectionsDone > 0) {
        await env2.DB.prepare(`UPDATE jobs SET last_milestone = ? WHERE id = ?`).bind(milestone, jobId).run();
        await sendTelegram(
          telegramToken,
          telegramChatId,
          `\u{1F4D6} <b>Translation ${milestone}%</b>
${sectionsDone}/${sectionsTotal} sections done`
        ).catch(() => void 0);
      }
    }
  }
}
__name(handleCron, "handleCron");
async function countOriginalSections(env2, jobId, unitStatus) {
  const mapped = await env2.DB.prepare(
    `SELECT COUNT(DISTINCT original_chunk_id) as n FROM chunks
     WHERE job_id = ? AND status = ? AND original_chunk_id IS NOT NULL`
  ).bind(jobId, unitStatus).first();
  const unmapped = await env2.DB.prepare(
    `SELECT COUNT(*) as n FROM chunks
     WHERE job_id = ? AND status = ? AND original_chunk_id IS NULL`
  ).bind(jobId, unitStatus).first();
  return (mapped?.n ?? 0) + (unmapped?.n ?? 0);
}
__name(countOriginalSections, "countOriginalSections");
var worker_default = {
  async fetch(request, env2) {
    try {
      return await handleRequest(request, env2);
    } catch (err) {
      console.error("Worker error:", err);
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  },
  async scheduled(_event, env2) {
    try {
      await handleCron(env2);
    } catch (err) {
      console.error("Cron error:", err);
    }
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env2, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env2);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env2, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env2);
  } catch (e) {
    const error3 = reduceError(e);
    return Response.json(error3, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-KLAA49/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env2, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env2, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env2, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env2, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-KLAA49/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof __Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
__name(__Facade_ScheduledController__, "__Facade_ScheduledController__");
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env2, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env2, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env2, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env2, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env2, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = (request, env2, ctx) => {
      this.env = env2;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    };
    #dispatcher = (type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    };
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
