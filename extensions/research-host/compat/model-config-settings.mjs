import { createRequire as __standaloneCreateRequire } from 'node:module'; const require = __standaloneCreateRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// dashboard/node_modules/graceful-fs/polyfills.js
var require_polyfills = __commonJS({
  "dashboard/node_modules/graceful-fs/polyfills.js"(exports, module) {
    var constants = __require("constants");
    var origCwd = process.cwd;
    var cwd = null;
    var platform = process.env.GRACEFUL_FS_PLATFORM || process.platform;
    process.cwd = function() {
      if (!cwd)
        cwd = origCwd.call(process);
      return cwd;
    };
    try {
      process.cwd();
    } catch (er) {
    }
    if (typeof process.chdir === "function") {
      chdir = process.chdir;
      process.chdir = function(d) {
        cwd = null;
        chdir.call(process, d);
      };
      if (Object.setPrototypeOf) Object.setPrototypeOf(process.chdir, chdir);
    }
    var chdir;
    module.exports = patch;
    function patch(fs) {
      if (constants.hasOwnProperty("O_SYMLINK") && process.version.match(/^v0\.6\.[0-2]|^v0\.5\./)) {
        patchLchmod(fs);
      }
      if (!fs.lutimes) {
        patchLutimes(fs);
      }
      fs.chown = chownFix(fs.chown);
      fs.fchown = chownFix(fs.fchown);
      fs.lchown = chownFix(fs.lchown);
      fs.chmod = chmodFix(fs.chmod);
      fs.fchmod = chmodFix(fs.fchmod);
      fs.lchmod = chmodFix(fs.lchmod);
      fs.chownSync = chownFixSync(fs.chownSync);
      fs.fchownSync = chownFixSync(fs.fchownSync);
      fs.lchownSync = chownFixSync(fs.lchownSync);
      fs.chmodSync = chmodFixSync(fs.chmodSync);
      fs.fchmodSync = chmodFixSync(fs.fchmodSync);
      fs.lchmodSync = chmodFixSync(fs.lchmodSync);
      fs.stat = statFix(fs.stat);
      fs.fstat = statFix(fs.fstat);
      fs.lstat = statFix(fs.lstat);
      fs.statSync = statFixSync(fs.statSync);
      fs.fstatSync = statFixSync(fs.fstatSync);
      fs.lstatSync = statFixSync(fs.lstatSync);
      if (fs.chmod && !fs.lchmod) {
        fs.lchmod = function(path3, mode, cb) {
          if (cb) process.nextTick(cb);
        };
        fs.lchmodSync = function() {
        };
      }
      if (fs.chown && !fs.lchown) {
        fs.lchown = function(path3, uid, gid, cb) {
          if (cb) process.nextTick(cb);
        };
        fs.lchownSync = function() {
        };
      }
      if (platform === "win32") {
        fs.rename = typeof fs.rename !== "function" ? fs.rename : (function(fs$rename) {
          function rename(from, to, cb) {
            var start = Date.now();
            var backoff = 0;
            fs$rename(from, to, function CB(er) {
              if (er && (er.code === "EACCES" || er.code === "EPERM" || er.code === "EBUSY") && Date.now() - start < 6e4) {
                setTimeout(function() {
                  fs.stat(to, function(stater, st) {
                    if (stater && stater.code === "ENOENT")
                      fs$rename(from, to, CB);
                    else
                      cb(er);
                  });
                }, backoff);
                if (backoff < 100)
                  backoff += 10;
                return;
              }
              if (cb) cb(er);
            });
          }
          if (Object.setPrototypeOf) Object.setPrototypeOf(rename, fs$rename);
          return rename;
        })(fs.rename);
      }
      fs.read = typeof fs.read !== "function" ? fs.read : (function(fs$read) {
        function read(fd, buffer, offset, length, position, callback_) {
          var callback;
          if (callback_ && typeof callback_ === "function") {
            var eagCounter = 0;
            callback = function(er, _, __) {
              if (er && er.code === "EAGAIN" && eagCounter < 10) {
                eagCounter++;
                return fs$read.call(fs, fd, buffer, offset, length, position, callback);
              }
              callback_.apply(this, arguments);
            };
          }
          return fs$read.call(fs, fd, buffer, offset, length, position, callback);
        }
        if (Object.setPrototypeOf) Object.setPrototypeOf(read, fs$read);
        return read;
      })(fs.read);
      fs.readSync = typeof fs.readSync !== "function" ? fs.readSync : /* @__PURE__ */ (function(fs$readSync) {
        return function(fd, buffer, offset, length, position) {
          var eagCounter = 0;
          while (true) {
            try {
              return fs$readSync.call(fs, fd, buffer, offset, length, position);
            } catch (er) {
              if (er.code === "EAGAIN" && eagCounter < 10) {
                eagCounter++;
                continue;
              }
              throw er;
            }
          }
        };
      })(fs.readSync);
      function patchLchmod(fs2) {
        fs2.lchmod = function(path3, mode, callback) {
          fs2.open(
            path3,
            constants.O_WRONLY | constants.O_SYMLINK,
            mode,
            function(err, fd) {
              if (err) {
                if (callback) callback(err);
                return;
              }
              fs2.fchmod(fd, mode, function(err2) {
                fs2.close(fd, function(err22) {
                  if (callback) callback(err2 || err22);
                });
              });
            }
          );
        };
        fs2.lchmodSync = function(path3, mode) {
          var fd = fs2.openSync(path3, constants.O_WRONLY | constants.O_SYMLINK, mode);
          var threw = true;
          var ret;
          try {
            ret = fs2.fchmodSync(fd, mode);
            threw = false;
          } finally {
            if (threw) {
              try {
                fs2.closeSync(fd);
              } catch (er) {
              }
            } else {
              fs2.closeSync(fd);
            }
          }
          return ret;
        };
      }
      function patchLutimes(fs2) {
        if (constants.hasOwnProperty("O_SYMLINK") && fs2.futimes) {
          fs2.lutimes = function(path3, at, mt, cb) {
            fs2.open(path3, constants.O_SYMLINK, function(er, fd) {
              if (er) {
                if (cb) cb(er);
                return;
              }
              fs2.futimes(fd, at, mt, function(er2) {
                fs2.close(fd, function(er22) {
                  if (cb) cb(er2 || er22);
                });
              });
            });
          };
          fs2.lutimesSync = function(path3, at, mt) {
            var fd = fs2.openSync(path3, constants.O_SYMLINK);
            var ret;
            var threw = true;
            try {
              ret = fs2.futimesSync(fd, at, mt);
              threw = false;
            } finally {
              if (threw) {
                try {
                  fs2.closeSync(fd);
                } catch (er) {
                }
              } else {
                fs2.closeSync(fd);
              }
            }
            return ret;
          };
        } else if (fs2.futimes) {
          fs2.lutimes = function(_a, _b, _c, cb) {
            if (cb) process.nextTick(cb);
          };
          fs2.lutimesSync = function() {
          };
        }
      }
      function chmodFix(orig) {
        if (!orig) return orig;
        return function(target, mode, cb) {
          return orig.call(fs, target, mode, function(er) {
            if (chownErOk(er)) er = null;
            if (cb) cb.apply(this, arguments);
          });
        };
      }
      function chmodFixSync(orig) {
        if (!orig) return orig;
        return function(target, mode) {
          try {
            return orig.call(fs, target, mode);
          } catch (er) {
            if (!chownErOk(er)) throw er;
          }
        };
      }
      function chownFix(orig) {
        if (!orig) return orig;
        return function(target, uid, gid, cb) {
          return orig.call(fs, target, uid, gid, function(er) {
            if (chownErOk(er)) er = null;
            if (cb) cb.apply(this, arguments);
          });
        };
      }
      function chownFixSync(orig) {
        if (!orig) return orig;
        return function(target, uid, gid) {
          try {
            return orig.call(fs, target, uid, gid);
          } catch (er) {
            if (!chownErOk(er)) throw er;
          }
        };
      }
      function statFix(orig) {
        if (!orig) return orig;
        return function(target, options, cb) {
          if (typeof options === "function") {
            cb = options;
            options = null;
          }
          function callback(er, stats) {
            if (stats) {
              if (stats.uid < 0) stats.uid += 4294967296;
              if (stats.gid < 0) stats.gid += 4294967296;
            }
            if (cb) cb.apply(this, arguments);
          }
          return options ? orig.call(fs, target, options, callback) : orig.call(fs, target, callback);
        };
      }
      function statFixSync(orig) {
        if (!orig) return orig;
        return function(target, options) {
          var stats = options ? orig.call(fs, target, options) : orig.call(fs, target);
          if (stats) {
            if (stats.uid < 0) stats.uid += 4294967296;
            if (stats.gid < 0) stats.gid += 4294967296;
          }
          return stats;
        };
      }
      function chownErOk(er) {
        if (!er)
          return true;
        if (er.code === "ENOSYS")
          return true;
        var nonroot = !process.getuid || process.getuid() !== 0;
        if (nonroot) {
          if (er.code === "EINVAL" || er.code === "EPERM")
            return true;
        }
        return false;
      }
    }
  }
});

// dashboard/node_modules/graceful-fs/legacy-streams.js
var require_legacy_streams = __commonJS({
  "dashboard/node_modules/graceful-fs/legacy-streams.js"(exports, module) {
    var Stream = __require("stream").Stream;
    module.exports = legacy;
    function legacy(fs) {
      return {
        ReadStream,
        WriteStream
      };
      function ReadStream(path3, options) {
        if (!(this instanceof ReadStream)) return new ReadStream(path3, options);
        Stream.call(this);
        var self = this;
        this.path = path3;
        this.fd = null;
        this.readable = true;
        this.paused = false;
        this.flags = "r";
        this.mode = 438;
        this.bufferSize = 64 * 1024;
        options = options || {};
        var keys = Object.keys(options);
        for (var index = 0, length = keys.length; index < length; index++) {
          var key = keys[index];
          this[key] = options[key];
        }
        if (this.encoding) this.setEncoding(this.encoding);
        if (this.start !== void 0) {
          if ("number" !== typeof this.start) {
            throw TypeError("start must be a Number");
          }
          if (this.end === void 0) {
            this.end = Infinity;
          } else if ("number" !== typeof this.end) {
            throw TypeError("end must be a Number");
          }
          if (this.start > this.end) {
            throw new Error("start must be <= end");
          }
          this.pos = this.start;
        }
        if (this.fd !== null) {
          process.nextTick(function() {
            self._read();
          });
          return;
        }
        fs.open(this.path, this.flags, this.mode, function(err, fd) {
          if (err) {
            self.emit("error", err);
            self.readable = false;
            return;
          }
          self.fd = fd;
          self.emit("open", fd);
          self._read();
        });
      }
      function WriteStream(path3, options) {
        if (!(this instanceof WriteStream)) return new WriteStream(path3, options);
        Stream.call(this);
        this.path = path3;
        this.fd = null;
        this.writable = true;
        this.flags = "w";
        this.encoding = "binary";
        this.mode = 438;
        this.bytesWritten = 0;
        options = options || {};
        var keys = Object.keys(options);
        for (var index = 0, length = keys.length; index < length; index++) {
          var key = keys[index];
          this[key] = options[key];
        }
        if (this.start !== void 0) {
          if ("number" !== typeof this.start) {
            throw TypeError("start must be a Number");
          }
          if (this.start < 0) {
            throw new Error("start must be >= zero");
          }
          this.pos = this.start;
        }
        this.busy = false;
        this._queue = [];
        if (this.fd === null) {
          this._open = fs.open;
          this._queue.push([this._open, this.path, this.flags, this.mode, void 0]);
          this.flush();
        }
      }
    }
  }
});

// dashboard/node_modules/graceful-fs/clone.js
var require_clone = __commonJS({
  "dashboard/node_modules/graceful-fs/clone.js"(exports, module) {
    "use strict";
    module.exports = clone;
    var getPrototypeOf = Object.getPrototypeOf || function(obj) {
      return obj.__proto__;
    };
    function clone(obj) {
      if (obj === null || typeof obj !== "object")
        return obj;
      if (obj instanceof Object)
        var copy = { __proto__: getPrototypeOf(obj) };
      else
        var copy = /* @__PURE__ */ Object.create(null);
      Object.getOwnPropertyNames(obj).forEach(function(key) {
        Object.defineProperty(copy, key, Object.getOwnPropertyDescriptor(obj, key));
      });
      return copy;
    }
  }
});

// dashboard/node_modules/graceful-fs/graceful-fs.js
var require_graceful_fs = __commonJS({
  "dashboard/node_modules/graceful-fs/graceful-fs.js"(exports, module) {
    var fs = __require("fs");
    var polyfills = require_polyfills();
    var legacy = require_legacy_streams();
    var clone = require_clone();
    var util = __require("util");
    var gracefulQueue;
    var previousSymbol;
    if (typeof Symbol === "function" && typeof Symbol.for === "function") {
      gracefulQueue = /* @__PURE__ */ Symbol.for("graceful-fs.queue");
      previousSymbol = /* @__PURE__ */ Symbol.for("graceful-fs.previous");
    } else {
      gracefulQueue = "___graceful-fs.queue";
      previousSymbol = "___graceful-fs.previous";
    }
    function noop() {
    }
    function publishQueue(context, queue2) {
      Object.defineProperty(context, gracefulQueue, {
        get: function() {
          return queue2;
        }
      });
    }
    var debug = noop;
    if (util.debuglog)
      debug = util.debuglog("gfs4");
    else if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || ""))
      debug = function() {
        var m = util.format.apply(util, arguments);
        m = "GFS4: " + m.split(/\n/).join("\nGFS4: ");
        console.error(m);
      };
    if (!fs[gracefulQueue]) {
      queue = global[gracefulQueue] || [];
      publishQueue(fs, queue);
      fs.close = (function(fs$close) {
        function close(fd, cb) {
          return fs$close.call(fs, fd, function(err) {
            if (!err) {
              resetQueue();
            }
            if (typeof cb === "function")
              cb.apply(this, arguments);
          });
        }
        Object.defineProperty(close, previousSymbol, {
          value: fs$close
        });
        return close;
      })(fs.close);
      fs.closeSync = (function(fs$closeSync) {
        function closeSync(fd) {
          fs$closeSync.apply(fs, arguments);
          resetQueue();
        }
        Object.defineProperty(closeSync, previousSymbol, {
          value: fs$closeSync
        });
        return closeSync;
      })(fs.closeSync);
      if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || "")) {
        process.on("exit", function() {
          debug(fs[gracefulQueue]);
          __require("assert").equal(fs[gracefulQueue].length, 0);
        });
      }
    }
    var queue;
    if (!global[gracefulQueue]) {
      publishQueue(global, fs[gracefulQueue]);
    }
    module.exports = patch(clone(fs));
    if (process.env.TEST_GRACEFUL_FS_GLOBAL_PATCH && !fs.__patched) {
      module.exports = patch(fs);
      fs.__patched = true;
    }
    function patch(fs2) {
      polyfills(fs2);
      fs2.gracefulify = patch;
      fs2.createReadStream = createReadStream;
      fs2.createWriteStream = createWriteStream;
      var fs$readFile = fs2.readFile;
      fs2.readFile = readFile;
      function readFile(path3, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        return go$readFile(path3, options, cb);
        function go$readFile(path4, options2, cb2, startTime) {
          return fs$readFile(path4, options2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$readFile, [path4, options2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$writeFile = fs2.writeFile;
      fs2.writeFile = writeFile;
      function writeFile(path3, data, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        return go$writeFile(path3, data, options, cb);
        function go$writeFile(path4, data2, options2, cb2, startTime) {
          return fs$writeFile(path4, data2, options2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$writeFile, [path4, data2, options2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$appendFile = fs2.appendFile;
      if (fs$appendFile)
        fs2.appendFile = appendFile;
      function appendFile(path3, data, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        return go$appendFile(path3, data, options, cb);
        function go$appendFile(path4, data2, options2, cb2, startTime) {
          return fs$appendFile(path4, data2, options2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$appendFile, [path4, data2, options2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$copyFile = fs2.copyFile;
      if (fs$copyFile)
        fs2.copyFile = copyFile;
      function copyFile(src, dest, flags, cb) {
        if (typeof flags === "function") {
          cb = flags;
          flags = 0;
        }
        return go$copyFile(src, dest, flags, cb);
        function go$copyFile(src2, dest2, flags2, cb2, startTime) {
          return fs$copyFile(src2, dest2, flags2, function(err) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$copyFile, [src2, dest2, flags2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      var fs$readdir = fs2.readdir;
      fs2.readdir = readdir;
      var noReaddirOptionVersions = /^v[0-5]\./;
      function readdir(path3, options, cb) {
        if (typeof options === "function")
          cb = options, options = null;
        var go$readdir = noReaddirOptionVersions.test(process.version) ? function go$readdir2(path4, options2, cb2, startTime) {
          return fs$readdir(path4, fs$readdirCallback(
            path4,
            options2,
            cb2,
            startTime
          ));
        } : function go$readdir2(path4, options2, cb2, startTime) {
          return fs$readdir(path4, options2, fs$readdirCallback(
            path4,
            options2,
            cb2,
            startTime
          ));
        };
        return go$readdir(path3, options, cb);
        function fs$readdirCallback(path4, options2, cb2, startTime) {
          return function(err, files) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([
                go$readdir,
                [path4, options2, cb2],
                err,
                startTime || Date.now(),
                Date.now()
              ]);
            else {
              if (files && files.sort)
                files.sort();
              if (typeof cb2 === "function")
                cb2.call(this, err, files);
            }
          };
        }
      }
      if (process.version.substr(0, 4) === "v0.8") {
        var legStreams = legacy(fs2);
        ReadStream = legStreams.ReadStream;
        WriteStream = legStreams.WriteStream;
      }
      var fs$ReadStream = fs2.ReadStream;
      if (fs$ReadStream) {
        ReadStream.prototype = Object.create(fs$ReadStream.prototype);
        ReadStream.prototype.open = ReadStream$open;
      }
      var fs$WriteStream = fs2.WriteStream;
      if (fs$WriteStream) {
        WriteStream.prototype = Object.create(fs$WriteStream.prototype);
        WriteStream.prototype.open = WriteStream$open;
      }
      Object.defineProperty(fs2, "ReadStream", {
        get: function() {
          return ReadStream;
        },
        set: function(val) {
          ReadStream = val;
        },
        enumerable: true,
        configurable: true
      });
      Object.defineProperty(fs2, "WriteStream", {
        get: function() {
          return WriteStream;
        },
        set: function(val) {
          WriteStream = val;
        },
        enumerable: true,
        configurable: true
      });
      var FileReadStream = ReadStream;
      Object.defineProperty(fs2, "FileReadStream", {
        get: function() {
          return FileReadStream;
        },
        set: function(val) {
          FileReadStream = val;
        },
        enumerable: true,
        configurable: true
      });
      var FileWriteStream = WriteStream;
      Object.defineProperty(fs2, "FileWriteStream", {
        get: function() {
          return FileWriteStream;
        },
        set: function(val) {
          FileWriteStream = val;
        },
        enumerable: true,
        configurable: true
      });
      function ReadStream(path3, options) {
        if (this instanceof ReadStream)
          return fs$ReadStream.apply(this, arguments), this;
        else
          return ReadStream.apply(Object.create(ReadStream.prototype), arguments);
      }
      function ReadStream$open() {
        var that = this;
        open(that.path, that.flags, that.mode, function(err, fd) {
          if (err) {
            if (that.autoClose)
              that.destroy();
            that.emit("error", err);
          } else {
            that.fd = fd;
            that.emit("open", fd);
            that.read();
          }
        });
      }
      function WriteStream(path3, options) {
        if (this instanceof WriteStream)
          return fs$WriteStream.apply(this, arguments), this;
        else
          return WriteStream.apply(Object.create(WriteStream.prototype), arguments);
      }
      function WriteStream$open() {
        var that = this;
        open(that.path, that.flags, that.mode, function(err, fd) {
          if (err) {
            that.destroy();
            that.emit("error", err);
          } else {
            that.fd = fd;
            that.emit("open", fd);
          }
        });
      }
      function createReadStream(path3, options) {
        return new fs2.ReadStream(path3, options);
      }
      function createWriteStream(path3, options) {
        return new fs2.WriteStream(path3, options);
      }
      var fs$open = fs2.open;
      fs2.open = open;
      function open(path3, flags, mode, cb) {
        if (typeof mode === "function")
          cb = mode, mode = null;
        return go$open(path3, flags, mode, cb);
        function go$open(path4, flags2, mode2, cb2, startTime) {
          return fs$open(path4, flags2, mode2, function(err, fd) {
            if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
              enqueue([go$open, [path4, flags2, mode2, cb2], err, startTime || Date.now(), Date.now()]);
            else {
              if (typeof cb2 === "function")
                cb2.apply(this, arguments);
            }
          });
        }
      }
      return fs2;
    }
    function enqueue(elem) {
      debug("ENQUEUE", elem[0].name, elem[1]);
      fs[gracefulQueue].push(elem);
      retry();
    }
    var retryTimer;
    function resetQueue() {
      var now = Date.now();
      for (var i = 0; i < fs[gracefulQueue].length; ++i) {
        if (fs[gracefulQueue][i].length > 2) {
          fs[gracefulQueue][i][3] = now;
          fs[gracefulQueue][i][4] = now;
        }
      }
      retry();
    }
    function retry() {
      clearTimeout(retryTimer);
      retryTimer = void 0;
      if (fs[gracefulQueue].length === 0)
        return;
      var elem = fs[gracefulQueue].shift();
      var fn = elem[0];
      var args = elem[1];
      var err = elem[2];
      var startTime = elem[3];
      var lastTime = elem[4];
      if (startTime === void 0) {
        debug("RETRY", fn.name, args);
        fn.apply(null, args);
      } else if (Date.now() - startTime >= 6e4) {
        debug("TIMEOUT", fn.name, args);
        var cb = args.pop();
        if (typeof cb === "function")
          cb.call(null, err);
      } else {
        var sinceAttempt = Date.now() - lastTime;
        var sinceStart = Math.max(lastTime - startTime, 1);
        var desiredDelay = Math.min(sinceStart * 1.2, 100);
        if (sinceAttempt >= desiredDelay) {
          debug("RETRY", fn.name, args);
          fn.apply(null, args.concat([startTime]));
        } else {
          fs[gracefulQueue].push(elem);
        }
      }
      if (retryTimer === void 0) {
        retryTimer = setTimeout(retry, 0);
      }
    }
  }
});

// dashboard/node_modules/proper-lockfile/node_modules/retry/lib/retry_operation.js
var require_retry_operation = __commonJS({
  "dashboard/node_modules/proper-lockfile/node_modules/retry/lib/retry_operation.js"(exports, module) {
    function RetryOperation(timeouts, options) {
      if (typeof options === "boolean") {
        options = { forever: options };
      }
      this._originalTimeouts = JSON.parse(JSON.stringify(timeouts));
      this._timeouts = timeouts;
      this._options = options || {};
      this._maxRetryTime = options && options.maxRetryTime || Infinity;
      this._fn = null;
      this._errors = [];
      this._attempts = 1;
      this._operationTimeout = null;
      this._operationTimeoutCb = null;
      this._timeout = null;
      this._operationStart = null;
      if (this._options.forever) {
        this._cachedTimeouts = this._timeouts.slice(0);
      }
    }
    module.exports = RetryOperation;
    RetryOperation.prototype.reset = function() {
      this._attempts = 1;
      this._timeouts = this._originalTimeouts;
    };
    RetryOperation.prototype.stop = function() {
      if (this._timeout) {
        clearTimeout(this._timeout);
      }
      this._timeouts = [];
      this._cachedTimeouts = null;
    };
    RetryOperation.prototype.retry = function(err) {
      if (this._timeout) {
        clearTimeout(this._timeout);
      }
      if (!err) {
        return false;
      }
      var currentTime = (/* @__PURE__ */ new Date()).getTime();
      if (err && currentTime - this._operationStart >= this._maxRetryTime) {
        this._errors.unshift(new Error("RetryOperation timeout occurred"));
        return false;
      }
      this._errors.push(err);
      var timeout = this._timeouts.shift();
      if (timeout === void 0) {
        if (this._cachedTimeouts) {
          this._errors.splice(this._errors.length - 1, this._errors.length);
          this._timeouts = this._cachedTimeouts.slice(0);
          timeout = this._timeouts.shift();
        } else {
          return false;
        }
      }
      var self = this;
      var timer = setTimeout(function() {
        self._attempts++;
        if (self._operationTimeoutCb) {
          self._timeout = setTimeout(function() {
            self._operationTimeoutCb(self._attempts);
          }, self._operationTimeout);
          if (self._options.unref) {
            self._timeout.unref();
          }
        }
        self._fn(self._attempts);
      }, timeout);
      if (this._options.unref) {
        timer.unref();
      }
      return true;
    };
    RetryOperation.prototype.attempt = function(fn, timeoutOps) {
      this._fn = fn;
      if (timeoutOps) {
        if (timeoutOps.timeout) {
          this._operationTimeout = timeoutOps.timeout;
        }
        if (timeoutOps.cb) {
          this._operationTimeoutCb = timeoutOps.cb;
        }
      }
      var self = this;
      if (this._operationTimeoutCb) {
        this._timeout = setTimeout(function() {
          self._operationTimeoutCb();
        }, self._operationTimeout);
      }
      this._operationStart = (/* @__PURE__ */ new Date()).getTime();
      this._fn(this._attempts);
    };
    RetryOperation.prototype.try = function(fn) {
      console.log("Using RetryOperation.try() is deprecated");
      this.attempt(fn);
    };
    RetryOperation.prototype.start = function(fn) {
      console.log("Using RetryOperation.start() is deprecated");
      this.attempt(fn);
    };
    RetryOperation.prototype.start = RetryOperation.prototype.try;
    RetryOperation.prototype.errors = function() {
      return this._errors;
    };
    RetryOperation.prototype.attempts = function() {
      return this._attempts;
    };
    RetryOperation.prototype.mainError = function() {
      if (this._errors.length === 0) {
        return null;
      }
      var counts = {};
      var mainError = null;
      var mainErrorCount = 0;
      for (var i = 0; i < this._errors.length; i++) {
        var error = this._errors[i];
        var message = error.message;
        var count = (counts[message] || 0) + 1;
        counts[message] = count;
        if (count >= mainErrorCount) {
          mainError = error;
          mainErrorCount = count;
        }
      }
      return mainError;
    };
  }
});

// dashboard/node_modules/proper-lockfile/node_modules/retry/lib/retry.js
var require_retry = __commonJS({
  "dashboard/node_modules/proper-lockfile/node_modules/retry/lib/retry.js"(exports) {
    var RetryOperation = require_retry_operation();
    exports.operation = function(options) {
      var timeouts = exports.timeouts(options);
      return new RetryOperation(timeouts, {
        forever: options && options.forever,
        unref: options && options.unref,
        maxRetryTime: options && options.maxRetryTime
      });
    };
    exports.timeouts = function(options) {
      if (options instanceof Array) {
        return [].concat(options);
      }
      var opts = {
        retries: 10,
        factor: 2,
        minTimeout: 1 * 1e3,
        maxTimeout: Infinity,
        randomize: false
      };
      for (var key in options) {
        opts[key] = options[key];
      }
      if (opts.minTimeout > opts.maxTimeout) {
        throw new Error("minTimeout is greater than maxTimeout");
      }
      var timeouts = [];
      for (var i = 0; i < opts.retries; i++) {
        timeouts.push(this.createTimeout(i, opts));
      }
      if (options && options.forever && !timeouts.length) {
        timeouts.push(this.createTimeout(i, opts));
      }
      timeouts.sort(function(a, b) {
        return a - b;
      });
      return timeouts;
    };
    exports.createTimeout = function(attempt, opts) {
      var random = opts.randomize ? Math.random() + 1 : 1;
      var timeout = Math.round(random * opts.minTimeout * Math.pow(opts.factor, attempt));
      timeout = Math.min(timeout, opts.maxTimeout);
      return timeout;
    };
    exports.wrap = function(obj, options, methods) {
      if (options instanceof Array) {
        methods = options;
        options = null;
      }
      if (!methods) {
        methods = [];
        for (var key in obj) {
          if (typeof obj[key] === "function") {
            methods.push(key);
          }
        }
      }
      for (var i = 0; i < methods.length; i++) {
        var method = methods[i];
        var original = obj[method];
        obj[method] = function retryWrapper(original2) {
          var op = exports.operation(options);
          var args = Array.prototype.slice.call(arguments, 1);
          var callback = args.pop();
          args.push(function(err) {
            if (op.retry(err)) {
              return;
            }
            if (err) {
              arguments[0] = op.mainError();
            }
            callback.apply(this, arguments);
          });
          op.attempt(function() {
            original2.apply(obj, args);
          });
        }.bind(obj, original);
        obj[method].options = options;
      }
    };
  }
});

// dashboard/node_modules/proper-lockfile/node_modules/retry/index.js
var require_retry2 = __commonJS({
  "dashboard/node_modules/proper-lockfile/node_modules/retry/index.js"(exports, module) {
    module.exports = require_retry();
  }
});

// dashboard/node_modules/proper-lockfile/node_modules/signal-exit/signals.js
var require_signals = __commonJS({
  "dashboard/node_modules/proper-lockfile/node_modules/signal-exit/signals.js"(exports, module) {
    module.exports = [
      "SIGABRT",
      "SIGALRM",
      "SIGHUP",
      "SIGINT",
      "SIGTERM"
    ];
    if (process.platform !== "win32") {
      module.exports.push(
        "SIGVTALRM",
        "SIGXCPU",
        "SIGXFSZ",
        "SIGUSR2",
        "SIGTRAP",
        "SIGSYS",
        "SIGQUIT",
        "SIGIOT"
        // should detect profiler and enable/disable accordingly.
        // see #21
        // 'SIGPROF'
      );
    }
    if (process.platform === "linux") {
      module.exports.push(
        "SIGIO",
        "SIGPOLL",
        "SIGPWR",
        "SIGSTKFLT",
        "SIGUNUSED"
      );
    }
  }
});

// dashboard/node_modules/proper-lockfile/node_modules/signal-exit/index.js
var require_signal_exit = __commonJS({
  "dashboard/node_modules/proper-lockfile/node_modules/signal-exit/index.js"(exports, module) {
    var process2 = global.process;
    var processOk = function(process3) {
      return process3 && typeof process3 === "object" && typeof process3.removeListener === "function" && typeof process3.emit === "function" && typeof process3.reallyExit === "function" && typeof process3.listeners === "function" && typeof process3.kill === "function" && typeof process3.pid === "number" && typeof process3.on === "function";
    };
    if (!processOk(process2)) {
      module.exports = function() {
        return function() {
        };
      };
    } else {
      assert = __require("assert");
      signals = require_signals();
      isWin = /^win/i.test(process2.platform);
      EE = __require("events");
      if (typeof EE !== "function") {
        EE = EE.EventEmitter;
      }
      if (process2.__signal_exit_emitter__) {
        emitter = process2.__signal_exit_emitter__;
      } else {
        emitter = process2.__signal_exit_emitter__ = new EE();
        emitter.count = 0;
        emitter.emitted = {};
      }
      if (!emitter.infinite) {
        emitter.setMaxListeners(Infinity);
        emitter.infinite = true;
      }
      module.exports = function(cb, opts) {
        if (!processOk(global.process)) {
          return function() {
          };
        }
        assert.equal(typeof cb, "function", "a callback must be provided for exit handler");
        if (loaded === false) {
          load();
        }
        var ev = "exit";
        if (opts && opts.alwaysLast) {
          ev = "afterexit";
        }
        var remove = function() {
          emitter.removeListener(ev, cb);
          if (emitter.listeners("exit").length === 0 && emitter.listeners("afterexit").length === 0) {
            unload();
          }
        };
        emitter.on(ev, cb);
        return remove;
      };
      unload = function unload2() {
        if (!loaded || !processOk(global.process)) {
          return;
        }
        loaded = false;
        signals.forEach(function(sig) {
          try {
            process2.removeListener(sig, sigListeners[sig]);
          } catch (er) {
          }
        });
        process2.emit = originalProcessEmit;
        process2.reallyExit = originalProcessReallyExit;
        emitter.count -= 1;
      };
      module.exports.unload = unload;
      emit = function emit2(event, code, signal) {
        if (emitter.emitted[event]) {
          return;
        }
        emitter.emitted[event] = true;
        emitter.emit(event, code, signal);
      };
      sigListeners = {};
      signals.forEach(function(sig) {
        sigListeners[sig] = function listener() {
          if (!processOk(global.process)) {
            return;
          }
          var listeners = process2.listeners(sig);
          if (listeners.length === emitter.count) {
            unload();
            emit("exit", null, sig);
            emit("afterexit", null, sig);
            if (isWin && sig === "SIGHUP") {
              sig = "SIGINT";
            }
            process2.kill(process2.pid, sig);
          }
        };
      });
      module.exports.signals = function() {
        return signals;
      };
      loaded = false;
      load = function load2() {
        if (loaded || !processOk(global.process)) {
          return;
        }
        loaded = true;
        emitter.count += 1;
        signals = signals.filter(function(sig) {
          try {
            process2.on(sig, sigListeners[sig]);
            return true;
          } catch (er) {
            return false;
          }
        });
        process2.emit = processEmit;
        process2.reallyExit = processReallyExit;
      };
      module.exports.load = load;
      originalProcessReallyExit = process2.reallyExit;
      processReallyExit = function processReallyExit2(code) {
        if (!processOk(global.process)) {
          return;
        }
        process2.exitCode = code || /* istanbul ignore next */
        0;
        emit("exit", process2.exitCode, null);
        emit("afterexit", process2.exitCode, null);
        originalProcessReallyExit.call(process2, process2.exitCode);
      };
      originalProcessEmit = process2.emit;
      processEmit = function processEmit2(ev, arg) {
        if (ev === "exit" && processOk(global.process)) {
          if (arg !== void 0) {
            process2.exitCode = arg;
          }
          var ret = originalProcessEmit.apply(this, arguments);
          emit("exit", process2.exitCode, null);
          emit("afterexit", process2.exitCode, null);
          return ret;
        } else {
          return originalProcessEmit.apply(this, arguments);
        }
      };
    }
    var assert;
    var signals;
    var isWin;
    var EE;
    var emitter;
    var unload;
    var emit;
    var sigListeners;
    var loaded;
    var load;
    var originalProcessReallyExit;
    var processReallyExit;
    var originalProcessEmit;
    var processEmit;
  }
});

// dashboard/node_modules/proper-lockfile/lib/mtime-precision.js
var require_mtime_precision = __commonJS({
  "dashboard/node_modules/proper-lockfile/lib/mtime-precision.js"(exports, module) {
    "use strict";
    var cacheSymbol = /* @__PURE__ */ Symbol();
    function probe(file, fs, callback) {
      const cachedPrecision = fs[cacheSymbol];
      if (cachedPrecision) {
        return fs.stat(file, (err, stat) => {
          if (err) {
            return callback(err);
          }
          callback(null, stat.mtime, cachedPrecision);
        });
      }
      const mtime = new Date(Math.ceil(Date.now() / 1e3) * 1e3 + 5);
      fs.utimes(file, mtime, mtime, (err) => {
        if (err) {
          return callback(err);
        }
        fs.stat(file, (err2, stat) => {
          if (err2) {
            return callback(err2);
          }
          const precision = stat.mtime.getTime() % 1e3 === 0 ? "s" : "ms";
          Object.defineProperty(fs, cacheSymbol, { value: precision });
          callback(null, stat.mtime, precision);
        });
      });
    }
    function getMtime(precision) {
      let now = Date.now();
      if (precision === "s") {
        now = Math.ceil(now / 1e3) * 1e3;
      }
      return new Date(now);
    }
    module.exports.probe = probe;
    module.exports.getMtime = getMtime;
  }
});

// dashboard/node_modules/proper-lockfile/lib/lockfile.js
var require_lockfile = __commonJS({
  "dashboard/node_modules/proper-lockfile/lib/lockfile.js"(exports, module) {
    "use strict";
    var path3 = __require("path");
    var fs = require_graceful_fs();
    var retry = require_retry2();
    var onExit = require_signal_exit();
    var mtimePrecision = require_mtime_precision();
    var locks = {};
    function getLockFile(file, options) {
      return options.lockfilePath || `${file}.lock`;
    }
    function resolveCanonicalPath(file, options, callback) {
      if (!options.realpath) {
        return callback(null, path3.resolve(file));
      }
      options.fs.realpath(file, callback);
    }
    function acquireLock2(file, options, callback) {
      const lockfilePath = getLockFile(file, options);
      options.fs.mkdir(lockfilePath, (err) => {
        if (!err) {
          return mtimePrecision.probe(lockfilePath, options.fs, (err2, mtime, mtimePrecision2) => {
            if (err2) {
              options.fs.rmdir(lockfilePath, () => {
              });
              return callback(err2);
            }
            callback(null, mtime, mtimePrecision2);
          });
        }
        if (err.code !== "EEXIST") {
          return callback(err);
        }
        if (options.stale <= 0) {
          return callback(Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED", file }));
        }
        options.fs.stat(lockfilePath, (err2, stat) => {
          if (err2) {
            if (err2.code === "ENOENT") {
              return acquireLock2(file, { ...options, stale: 0 }, callback);
            }
            return callback(err2);
          }
          if (!isLockStale(stat, options)) {
            return callback(Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED", file }));
          }
          removeLock(file, options, (err3) => {
            if (err3) {
              return callback(err3);
            }
            acquireLock2(file, { ...options, stale: 0 }, callback);
          });
        });
      });
    }
    function isLockStale(stat, options) {
      return stat.mtime.getTime() < Date.now() - options.stale;
    }
    function removeLock(file, options, callback) {
      options.fs.rmdir(getLockFile(file, options), (err) => {
        if (err && err.code !== "ENOENT") {
          return callback(err);
        }
        callback();
      });
    }
    function updateLock(file, options) {
      const lock2 = locks[file];
      if (lock2.updateTimeout) {
        return;
      }
      lock2.updateDelay = lock2.updateDelay || options.update;
      lock2.updateTimeout = setTimeout(() => {
        lock2.updateTimeout = null;
        options.fs.stat(lock2.lockfilePath, (err, stat) => {
          const isOverThreshold = lock2.lastUpdate + options.stale < Date.now();
          if (err) {
            if (err.code === "ENOENT" || isOverThreshold) {
              return setLockAsCompromised(file, lock2, Object.assign(err, { code: "ECOMPROMISED" }));
            }
            lock2.updateDelay = 1e3;
            return updateLock(file, options);
          }
          const isMtimeOurs = lock2.mtime.getTime() === stat.mtime.getTime();
          if (!isMtimeOurs) {
            return setLockAsCompromised(
              file,
              lock2,
              Object.assign(
                new Error("Unable to update lock within the stale threshold"),
                { code: "ECOMPROMISED" }
              )
            );
          }
          const mtime = mtimePrecision.getMtime(lock2.mtimePrecision);
          options.fs.utimes(lock2.lockfilePath, mtime, mtime, (err2) => {
            const isOverThreshold2 = lock2.lastUpdate + options.stale < Date.now();
            if (lock2.released) {
              return;
            }
            if (err2) {
              if (err2.code === "ENOENT" || isOverThreshold2) {
                return setLockAsCompromised(file, lock2, Object.assign(err2, { code: "ECOMPROMISED" }));
              }
              lock2.updateDelay = 1e3;
              return updateLock(file, options);
            }
            lock2.mtime = mtime;
            lock2.lastUpdate = Date.now();
            lock2.updateDelay = null;
            updateLock(file, options);
          });
        });
      }, lock2.updateDelay);
      if (lock2.updateTimeout.unref) {
        lock2.updateTimeout.unref();
      }
    }
    function setLockAsCompromised(file, lock2, err) {
      lock2.released = true;
      if (lock2.updateTimeout) {
        clearTimeout(lock2.updateTimeout);
      }
      if (locks[file] === lock2) {
        delete locks[file];
      }
      lock2.options.onCompromised(err);
    }
    function lock(file, options, callback) {
      options = {
        stale: 1e4,
        update: null,
        realpath: true,
        retries: 0,
        fs,
        onCompromised: (err) => {
          throw err;
        },
        ...options
      };
      options.retries = options.retries || 0;
      options.retries = typeof options.retries === "number" ? { retries: options.retries } : options.retries;
      options.stale = Math.max(options.stale || 0, 2e3);
      options.update = options.update == null ? options.stale / 2 : options.update || 0;
      options.update = Math.max(Math.min(options.update, options.stale / 2), 1e3);
      resolveCanonicalPath(file, options, (err, file2) => {
        if (err) {
          return callback(err);
        }
        const operation = retry.operation(options.retries);
        operation.attempt(() => {
          acquireLock2(file2, options, (err2, mtime, mtimePrecision2) => {
            if (operation.retry(err2)) {
              return;
            }
            if (err2) {
              return callback(operation.mainError());
            }
            const lock2 = locks[file2] = {
              lockfilePath: getLockFile(file2, options),
              mtime,
              mtimePrecision: mtimePrecision2,
              options,
              lastUpdate: Date.now()
            };
            updateLock(file2, options);
            callback(null, (releasedCallback) => {
              if (lock2.released) {
                return releasedCallback && releasedCallback(Object.assign(new Error("Lock is already released"), { code: "ERELEASED" }));
              }
              unlock(file2, { ...options, realpath: false }, releasedCallback);
            });
          });
        });
      });
    }
    function unlock(file, options, callback) {
      options = {
        fs,
        realpath: true,
        ...options
      };
      resolveCanonicalPath(file, options, (err, file2) => {
        if (err) {
          return callback(err);
        }
        const lock2 = locks[file2];
        if (!lock2) {
          return callback(Object.assign(new Error("Lock is not acquired/owned by you"), { code: "ENOTACQUIRED" }));
        }
        lock2.updateTimeout && clearTimeout(lock2.updateTimeout);
        lock2.released = true;
        delete locks[file2];
        removeLock(file2, options, callback);
      });
    }
    function check(file, options, callback) {
      options = {
        stale: 1e4,
        realpath: true,
        fs,
        ...options
      };
      options.stale = Math.max(options.stale || 0, 2e3);
      resolveCanonicalPath(file, options, (err, file2) => {
        if (err) {
          return callback(err);
        }
        options.fs.stat(getLockFile(file2, options), (err2, stat) => {
          if (err2) {
            return err2.code === "ENOENT" ? callback(null, false) : callback(err2);
          }
          return callback(null, !isLockStale(stat, options));
        });
      });
    }
    function getLocks() {
      return locks;
    }
    onExit(() => {
      for (const file in locks) {
        const options = locks[file].options;
        try {
          options.fs.rmdirSync(getLockFile(file, options));
        } catch (e) {
        }
      }
    });
    module.exports.lock = lock;
    module.exports.unlock = unlock;
    module.exports.check = check;
    module.exports.getLocks = getLocks;
  }
});

// dashboard/node_modules/proper-lockfile/lib/adapter.js
var require_adapter = __commonJS({
  "dashboard/node_modules/proper-lockfile/lib/adapter.js"(exports, module) {
    "use strict";
    var fs = require_graceful_fs();
    function createSyncFs(fs2) {
      const methods = ["mkdir", "realpath", "stat", "rmdir", "utimes"];
      const newFs = { ...fs2 };
      methods.forEach((method) => {
        newFs[method] = (...args) => {
          const callback = args.pop();
          let ret;
          try {
            ret = fs2[`${method}Sync`](...args);
          } catch (err) {
            return callback(err);
          }
          callback(null, ret);
        };
      });
      return newFs;
    }
    function toPromise(method) {
      return (...args) => new Promise((resolve2, reject) => {
        args.push((err, result) => {
          if (err) {
            reject(err);
          } else {
            resolve2(result);
          }
        });
        method(...args);
      });
    }
    function toSync(method) {
      return (...args) => {
        let err;
        let result;
        args.push((_err, _result) => {
          err = _err;
          result = _result;
        });
        method(...args);
        if (err) {
          throw err;
        }
        return result;
      };
    }
    function toSyncOptions(options) {
      options = { ...options };
      options.fs = createSyncFs(options.fs || fs);
      if (typeof options.retries === "number" && options.retries > 0 || options.retries && typeof options.retries.retries === "number" && options.retries.retries > 0) {
        throw Object.assign(new Error("Cannot use retries with the sync api"), { code: "ESYNC" });
      }
      return options;
    }
    module.exports = {
      toPromise,
      toSync,
      toSyncOptions
    };
  }
});

// dashboard/node_modules/proper-lockfile/index.js
var require_proper_lockfile = __commonJS({
  "dashboard/node_modules/proper-lockfile/index.js"(exports, module) {
    "use strict";
    var lockfile2 = require_lockfile();
    var { toPromise, toSync, toSyncOptions } = require_adapter();
    async function lock(file, options) {
      const release = await toPromise(lockfile2.lock)(file, options);
      return toPromise(release);
    }
    function lockSync(file, options) {
      const release = toSync(lockfile2.lock)(file, toSyncOptions(options));
      return toSync(release);
    }
    function unlock(file, options) {
      return toPromise(lockfile2.unlock)(file, options);
    }
    function unlockSync(file, options) {
      return toSync(lockfile2.unlock)(file, toSyncOptions(options));
    }
    function check(file, options) {
      return toPromise(lockfile2.check)(file, options);
    }
    function checkSync(file, options) {
      return toSync(lockfile2.check)(file, toSyncOptions(options));
    }
    module.exports = lock;
    module.exports.lock = lock;
    module.exports.unlock = unlock;
    module.exports.lockSync = lockSync;
    module.exports.unlockSync = unlockSync;
    module.exports.check = check;
    module.exports.checkSync = checkSync;
  }
});

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/pi-agent-settings.ts
import { createHash, randomBytes } from "node:crypto";
import { promises as fsp, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/dashboard-paths.ts
import os2 from "node:os";
import path2 from "node:path";

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/managed-paths.ts
import path from "node:path";
import os from "node:os";
function getManagedDir(env) {
  return path.join(env?.homedir ?? os.homedir(), ".pi-dashboard");
}
function getManagedBin(env) {
  return path.join(getManagedDir(env), "node_modules", ".bin");
}
function getPiSettingsPath(env) {
  return path.join(env?.homedir ?? os.homedir(), ".pi", "agent", "settings.json");
}
var MANAGED_DIR = getManagedDir();
var MANAGED_BIN = getManagedBin();
var PI_SETTINGS_PATH = getPiSettingsPath();

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/platform/paths.ts
function sunPathMax(platform = process.platform) {
  return platform === "darwin" ? 104 : 108;
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/dashboard-paths.ts
function expandTilde(p, env) {
  if (p === "~") return env?.homedir ?? os2.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path2.join(env?.homedir ?? os2.homedir(), p.slice(2));
  }
  return p;
}
function resolvePiAgentDir(env) {
  const t = (env?.agentDirEnv ?? process.env.PI_CODING_AGENT_DIR)?.trim();
  return t ? expandTilde(t, env) : path2.join(env?.homedir ?? os2.homedir(), ".pi", "agent");
}
var SUN_PATH_MAX = sunPathMax();

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/pi-settings-keys.ts
var PI_MANAGED_SETTINGS_KEYS = ["defaultProvider", "defaultModel", "defaultThinkingLevel"];

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/pi-settings-schema.ts
var MODES = ["all", "one-at-a-time"];
var bool = (key, def, category, label, hint) => ({
  key,
  kind: "bool",
  def,
  category,
  label,
  hint
});
var intKey = (key, def, category, label, hint, extra = { min: 0 }) => ({ key, kind: "int", def, category, label, hint, ...extra });
var str = (key, def, category, label, hint, defText) => ({ key, kind: "string", def, category, label, hint, ...defText ? { defText } : {} });
var enumKey = (key, options, def, category, label, hint) => ({ key, kind: "enum", options, def, category, label, hint });
var PI_SETTINGS_SCHEMA = [
  // Model and thinking
  bool("hideThinkingBlock", false, "model", "Hide thinking blocks", "Hide thinking blocks in pi's transcript"),
  bool("showCacheMissNotices", false, "model", "Cache notices", "Notices for cache misses, cache warming, compaction usage and provider recovery"),
  enumKey("cacheWarming", ["off", "streaming", "idle"], "streaming", "model", "Cache warming", "Keep provider prompt caches warm during runs, or between runs with idle"),
  intKey("thinkingBudgets.minimal", null, "model", "Thinking budget: minimal", "Token budget for the minimal thinking level", { min: 0, defText: "built-in" }),
  intKey("thinkingBudgets.low", null, "model", "Thinking budget: low", "Token budget for the low thinking level", { min: 0, defText: "built-in" }),
  intKey("thinkingBudgets.medium", null, "model", "Thinking budget: medium", "Token budget for the medium thinking level", { min: 0, defText: "built-in" }),
  intKey("thinkingBudgets.high", null, "model", "Thinking budget: high", "Token budget for the high thinking level", { min: 0, defText: "built-in" }),
  {
    key: "enabledModels",
    kind: "stringArray",
    def: null,
    defText: "all models",
    category: "model",
    label: "Model cycling scope",
    hint: "Models pi cycles through (Ctrl+P) and the dashboard model picker lists"
  },
  // Interaction
  enumKey("steeringMode", MODES, "one-at-a-time", "interaction", "Steering mode", "How queued steering messages are delivered"),
  enumKey("followUpMode", MODES, "one-at-a-time", "interaction", "Follow-up mode", "How queued follow-up messages are delivered"),
  str("externalEditor", null, "interaction", "External editor", "Command opened by the external-editor keybinding", "$VISUAL, $EDITOR, then platform default"),
  enumKey("doubleEscapeAction", ["tree", "fork", "none"], "tree", "interaction", "Double Escape action", "Action for double Escape with an empty editor"),
  enumKey("treeFilterMode", ["default", "no-tools", "user-only", "labeled-only", "all"], "default", "interaction", "Tree filter", "Initial filter used by /tree"),
  enumKey("defaultProjectTrust", ["ask", "always", "never"], "ask", "interaction", "Default project trust", "Fallback project-trust behavior"),
  // Tools
  enumKey("codemode.mode", ["on", "only"], "on", "tools", "Codemode mode", "How the codemode tool presents tools while it is active"),
  intKey("codemode.inlineBudget", 3e3, "tools", "Codemode inline budget", "Estimated tokens the codemode tool description may spend on tool declarations"),
  // Sessions and context
  str("sessionDir", null, "sessions", "Session directory", "Session storage directory", "agent session directory"),
  bool("compaction.enabled", true, "sessions", "Auto-compaction", "Compact long conversations automatically"),
  intKey("compaction.reserveTokens", 16384, "sessions", "Compaction reserve tokens", "Tokens reserved for the model response"),
  intKey("compaction.keepRecentTokens", 2e4, "sessions", "Compaction keep-recent tokens", "Recent tokens retained without summarization"),
  intKey("branchSummary.reserveTokens", 16384, "sessions", "Branch summary reserve tokens", "Tokens reserved when summarizing branch history"),
  bool("branchSummary.skipPrompt", false, "sessions", "Skip branch summary prompt", "Skip the branch-summary prompt and default to no summary"),
  enumKey("sessionShareDestination", ["auto", "gist", "radius"], "auto", "sessions", "Share destination", "Where /share publishes a session: auto uses Radius when authenticated, else a GitHub gist; radius never falls back to a gist"),
  // Terminal and display
  {
    ...str("theme", "system", "terminal", "Terminal theme", "Built-in or custom pi theme name; system derives colors from the terminal"),
    nonEmpty: true
  },
  {
    key: "quietStartup",
    kind: "mixed",
    options: ["header"],
    mixedBool: true,
    def: false,
    category: "terminal",
    label: "Quiet startup",
    hint: "true hides the startup header and resource listing; header keeps the header only"
  },
  intKey("editorPaddingX", 0, "terminal", "Editor padding", "Horizontal editor padding in cells", { min: 0, max: 3 }),
  intKey("autocompleteMaxVisible", 5, "terminal", "Autocomplete entries", "Visible autocomplete entries", { min: 3, max: 20 }),
  bool("showHardwareCursor", false, "terminal", "Hardware cursor", "Show the terminal cursor while pi positions it for input methods"),
  bool("terminal.showImages", true, "terminal", "Inline images", "Display inline images when supported"),
  intKey("terminal.imageWidthCells", 60, "terminal", "Image width", "Preferred inline image width in terminal cells", { min: 1 }),
  bool("terminal.clearOnShrink", false, "terminal", "Clear on shrink", "Clear empty rows when rendered content shrinks"),
  bool("terminal.showTerminalProgress", false, "terminal", "Terminal progress", "Show OSC 9;4 progress in the terminal tab"),
  {
    key: "terminal.hyperlinks",
    kind: "mixed",
    mixedBool: true,
    options: ["auto"],
    def: "auto",
    category: "terminal",
    label: "Hyperlinks",
    hint: "Override OSC 8 hyperlink detection"
  },
  {
    key: "terminal.images",
    kind: "mixed",
    options: ["kitty", "iterm2", "auto"],
    mixedFalseOnly: true,
    def: "auto",
    category: "terminal",
    label: "Image protocol",
    hint: "Override inline-image protocol detection"
  },
  {
    key: "terminal.trueColor",
    kind: "mixed",
    mixedBool: true,
    options: ["auto"],
    def: "auto",
    category: "terminal",
    label: "True color",
    hint: "Override true-color detection"
  },
  bool("images.autoResize", true, "terminal", "Resize images", "Resize images to at most 2000 by 2000 pixels before sending them to a model"),
  bool("images.blockImages", false, "terminal", "Block images", "Prevent images from being sent to models"),
  str("markdown.codeBlockIndent", "  ", "terminal", "Code block indent", "Prefix used to indent rendered code blocks"),
  enumKey("markdown.mermaid", ["off", "final", "streaming"], "streaming", "terminal", "Mermaid rendering", "Mermaid rendering mode"),
  // Network
  enumKey("transport", ["auto", "sse", "websocket", "websocket-cached"], "auto", "network", "Transport", "Preferred transport for providers that support several"),
  str("httpProxy", null, "network", "HTTP proxy", "Proxy URL applied as HTTP_PROXY and HTTPS_PROXY for pi's HTTP clients", "none"),
  intKey("httpIdleTimeoutMs", 3e5, "network", "HTTP idle timeout (ms)", "HTTP header and body idle timeout; 0 disables"),
  intKey("websocketConnectTimeoutMs", 15e3, "network", "WebSocket connect timeout (ms)", "WebSocket connection timeout; 0 disables"),
  // Shell
  str("shellPath", null, "shell", "Shell path", "Custom shell executable path", "platform default"),
  str("shellCommandPrefix", null, "shell", "Shell command prefix", "Prefix prepended to every shell command", "none"),
  // Resources
  bool("enableSkillCommands", true, "resources", "Skill commands", "Register skills as /skill:name commands"),
  // Updates and privacy
  bool("collapseChangelog", false, "updates", "Condensed changelog", "Show a condensed changelog after an update"),
  bool("enableInstallTelemetry", true, "updates", "Install telemetry", "Anonymous install/update reporting and selected provider attribution headers"),
  bool("enableAnalytics", false, "updates", "Analytics", "Opt in to analytics data sharing"),
  bool("warnings.anthropicExtraUsage", true, "updates", "Anthropic extra-usage warning", "Warn when Anthropic subscription authentication may use paid extra usage")
];
var PI_SETTINGS_BLOCKS = [
  "compaction",
  "branchSummary",
  "codemode",
  "terminal",
  "images",
  "markdown",
  "warnings",
  "thinkingBudgets"
];
var BY_KEY = new Map(PI_SETTINGS_SCHEMA.map((d) => [d.key, d]));
var getPiSettingDef = (key) => BY_KEY.get(key);
var checkInt = (def, v) => {
  const lo = def.min ?? 0;
  const ok = typeof v === "number" && Number.isInteger(v) && v >= lo && (def.max === void 0 || v <= def.max);
  if (ok) return null;
  if (def.max !== void 0) return `must be an integer from ${lo} to ${def.max}`;
  return lo > 0 ? `must be an integer of at least ${lo}` : "must be a non-negative integer";
};
var checkString = (def, v) => {
  if (typeof v !== "string") return "must be a string";
  return def.nonEmpty && v.length === 0 ? "must be a non-empty string" : null;
};
var checkStringArray = (_def, v) => Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0) ? null : "must be an array of non-empty strings";
var checkEnum = (def, v) => typeof v === "string" && (def.options ?? []).includes(v) ? null : `must be one of ${(def.options ?? []).map((o) => `"${o}"`).join(", ")}`;
var checkMixed = (def, v) => {
  const accepted = def.mixedBool && typeof v === "boolean" || def.mixedFalseOnly && v === false;
  if (accepted || typeof v === "string" && (def.options ?? []).includes(v)) return null;
  const literals = def.mixedBool ? ["true", "false"] : def.mixedFalseOnly ? ["false"] : [];
  return `must be ${[...literals, ...(def.options ?? []).map((o) => `"${o}"`)].join(", ")}`;
};
var KIND_CHECKS = {
  bool: (_def, v) => typeof v === "boolean" ? null : "must be a boolean",
  int: checkInt,
  string: checkString,
  stringArray: checkStringArray,
  enum: checkEnum,
  mixed: checkMixed
};
function checkPiSettingValue(def, v) {
  return KIND_CHECKS[def.kind](def, v);
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/role-schema.ts
var THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/pi-agent-settings.ts
var import_proper_lockfile = __toESM(require_proper_lockfile());
var _require = createRequire(import.meta.url);
var _lockfile = import_proper_lockfile.default;
var PI_RETRY_DEFAULTS = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2e3,
  provider: {
    // timeoutMs intentionally absent → pi uses the SDK default.
    maxRetries: 0,
    maxRetryDelayMs: 6e4
  }
};
var defaultFs = {
  readFile: (p) => fsp.readFile(p, "utf-8"),
  writeFile: (p, d) => fsp.writeFile(p, d, "utf-8"),
  rename: (a, b) => fsp.rename(a, b),
  chmod: (p, m) => fsp.chmod(p, m),
  stat: (p) => fsp.stat(p),
  lstat: (p) => fsp.lstat(p),
  realpath: (p) => fsp.realpath(p),
  readlink: (p) => fsp.readlink(p),
  mkdir: async (p) => {
    await fsp.mkdir(p, { recursive: true });
  },
  unlink: (p) => fsp.unlink(p)
};
function piSettingsPath(deps = {}) {
  return join(resolvePiAgentDir({ homedir: deps.home, agentDirEnv: deps.agentDirEnv }), "settings.json");
}
function asObject(v) {
  return isPlainObject(v) ? v : {};
}
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function num(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
var stripBom = (s) => s.charCodeAt(0) === 65279 ? s.slice(1) : s;
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}
function lineColumnAt(text, position) {
  const upto = text.slice(0, Math.max(0, Math.min(position, text.length)));
  const lines = upto.split("\n");
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
}
function describeParseFailure(err, text) {
  const msg = err instanceof Error ? err.message : "";
  const lc = /\(line (\d+) column (\d+)\)/.exec(msg);
  if (lc) return `Invalid JSON at line ${lc[1]}, column ${lc[2]}`;
  const pos = /\bposition (\d+)/.exec(msg);
  if (pos) {
    const { line, column } = lineColumnAt(text, Number(pos[1]));
    return `Invalid JSON at line ${line}, column ${column}`;
  }
  return "Invalid JSON";
}
function parseText(raw) {
  const text = stripBom(raw);
  try {
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) return { error: "settings.json must contain a JSON object" };
    return { obj: parsed };
  } catch (err) {
    return { error: describeParseFailure(err, text) };
  }
}
function computePiSettingsEtag(raw) {
  if (raw === null) return "absent";
  const { obj } = parseText(raw);
  if (!obj) return createHash("sha256").update(raw).digest("hex");
  const rest = { ...obj };
  for (const k of PI_MANAGED_SETTINGS_KEYS) delete rest[k];
  return createHash("sha256").update(JSON.stringify(sortKeys(rest))).digest("hex");
}
function buildState(raw) {
  if (raw === null) return { settings: {}, raw: "", etag: "absent", exists: false };
  const { obj, error } = parseText(raw);
  return {
    settings: obj ?? {},
    raw,
    etag: computePiSettingsEtag(raw),
    ...error ? { parseError: error } : {},
    exists: true
  };
}
function readRawSync(path3) {
  try {
    return readFileSync(path3, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}
function readPiSettings(deps = {}) {
  return buildState(readRawSync(piSettingsPath(deps)));
}
var LOCK_OPTIONS = {
  realpath: false,
  stale: 1e4,
  retries: { retries: 10, minTimeout: 20, maxTimeout: 20 }
};
var formatJson = (obj) => `${JSON.stringify(obj, null, 2)}
`;
async function resolveWriteTarget(path3, fs) {
  try {
    if (!(await fs.lstat(path3)).isSymbolicLink()) return path3;
  } catch {
    return path3;
  }
  try {
    return await fs.realpath(path3);
  } catch {
    return resolve(dirname(path3), await fs.readlink(path3));
  }
}
var errMessage = (err) => err instanceof Error ? err.message : String(err);
async function acquireLock(path3, fs) {
  try {
    await fs.mkdir(dirname(path3));
    const release = await _lockfile.lock(path3, {
      ...LOCK_OPTIONS,
      onCompromised: (err) => {
        console.warn(`[pi-settings] lock compromised (${err.code ?? "unknown"})`);
      }
    });
    return { release };
  } catch (err) {
    if (err?.code === "ELOCKED") return { fail: { ok: false, error: "busy" } };
    return { fail: { ok: false, error: "io", message: errMessage(err) } };
  }
}
var isEnoent = (err) => err.code === "ENOENT";
async function readCurrent(path3, fs) {
  try {
    return await fs.readFile(path3);
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}
async function replaceAtomically(path3, text, existed, fs) {
  const target = await resolveWriteTarget(path3, fs);
  const tmp = join(dirname(target), `.${randomBytes(6).toString("hex")}.settings.tmp`);
  try {
    await fs.writeFile(tmp, text);
    if (existed) {
      try {
        await fs.chmod(tmp, (await fs.stat(target)).mode & 4095);
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
    }
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {
    });
    throw err;
  }
}
async function withPiSettingsLock(fn, options = {}, deps = {}) {
  const fs = { ...defaultFs, ...deps.fs };
  const path3 = piSettingsPath(deps);
  const lock = await acquireLock(path3, fs);
  if ("fail" in lock) return lock.fail;
  try {
    const state = buildState(await readCurrent(path3, fs));
    if (options.baseEtag !== void 0 && options.baseEtag !== state.etag) {
      return { ok: false, error: "stale", state };
    }
    const step = fn(state);
    if ("fail" in step) return { ok: false, error: "fn", fail: step.fail };
    if (step.write === void 0) return { ok: true, value: step.value, state };
    await replaceAtomically(path3, step.write, state.exists, fs);
    return { ok: true, value: step.value, state: buildState(step.write) };
  } catch (err) {
    return { ok: false, error: "io", message: errMessage(err) };
  } finally {
    await lock.release().catch(() => {
    });
  }
}
var isManaged = (k) => PI_MANAGED_SETTINGS_KEYS.includes(k);
var isBlock = (k) => PI_SETTINGS_BLOCKS.includes(k);
var JSON_HINT = "use the JSON editor for this key";
var fieldError = (field, message) => ({ field, message });
function checkLeaf(key, value) {
  const def = getPiSettingDef(key);
  if (!def) return [fieldError(key, `${key} is not a form field; ${JSON_HINT}`)];
  const msg = value === null ? null : checkPiSettingValue(def, value);
  return msg ? [fieldError(key, `${key} ${msg}`)] : [];
}
function checkPatchBlock(key, value) {
  if (value === null) return [fieldError(key, `${key} cannot be removed as a whole block; clear its fields instead`)];
  if (!isPlainObject(value)) return [fieldError(key, `${key} must be an object`)];
  return Object.entries(value).filter(([, lv]) => lv !== void 0).flatMap(([leaf, lv]) => checkLeaf(`${key}.${leaf}`, lv));
}
function checkPatchKey(key, value) {
  if (isManaged(key)) {
    return [fieldError(key, `${key} is managed by the Default model control and cannot be edited here`)];
  }
  if (isBlock(key)) return checkPatchBlock(key, value);
  if (key.includes(".")) return [fieldError(key, `${key} is not a form field; ${JSON_HINT}`)];
  return checkLeaf(key, value);
}
function validatePiSettingsPatch(patch) {
  if (!isPlainObject(patch)) return [fieldError("patch", "patch must be an object")];
  return Object.entries(patch).filter(([, value]) => value !== void 0).flatMap(([key, value]) => checkPatchKey(key, value));
}
function applyBlockPatch(existing, leaves) {
  const block = { ...asObject(existing) };
  for (const [leaf, lv] of Object.entries(leaves)) {
    if (lv === null) delete block[leaf];
    else if (lv !== void 0) block[leaf] = lv;
  }
  return existing === void 0 && Object.keys(block).length === 0 ? void 0 : block;
}
function applyLeafPatch(current, patch) {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === void 0) continue;
    if (isBlock(key)) {
      const block = applyBlockPatch(next[key], value);
      if (block) next[key] = block;
    } else if (value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
}
function toWriteResult(r, extra) {
  if (r.ok) return { ok: true, state: r.state, ...extra(r.value) };
  if (r.error === "fn") return { ok: false, error: "parse", parseError: r.fail.parseError };
  return r;
}
async function applyPiSettingsPatch(patch, baseEtag, deps = {}) {
  const errors = validatePiSettingsPatch(patch);
  if (errors.length > 0) return { ok: false, error: "invalid", errors };
  const r = await withPiSettingsLock(
    (state) => {
      if (state.parseError) return { fail: { error: "parse", parseError: state.parseError } };
      const next = applyLeafPatch(state.settings, patch);
      if (sameJson(next, state.settings)) return { value: null };
      return { value: null, write: formatJson(next) };
    },
    { baseEtag },
    deps
  );
  return toWriteResult(r, () => ({}));
}
var isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
var isPosInt = (v) => typeof v === "number" && Number.isInteger(v) && v >= 1;
var isNonNeg = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0;
var rule = (ok, message) => (v) => ok(v) ? null : message;
var RAW_KEY_RULES = {
  extensions: rule(isStringArray, "must be an array of strings"),
  prompts: rule(isStringArray, "must be an array of strings"),
  themes: rule(isStringArray, "must be an array of strings"),
  enabledModels: rule(isStringArray, "must be an array of strings"),
  defaultTools: rule(isStringArray, "must be an array of strings"),
  npmCommand: rule(isStringArray, "must be an array of strings"),
  skills: rule((v) => isStringArray(v) || isPlainObject(v), "must be an array of strings (or the legacy object form)"),
  packages: rule(
    (v) => Array.isArray(v) && v.every((p) => typeof p === "string" || isPlainObject(p)),
    "must be an array of strings or objects"
  ),
  shellPath: rule((v) => typeof v === "string", "must be a string"),
  shellCommandPrefix: rule((v) => typeof v === "string", "must be a string"),
  modelThinkingLevels: rule(
    (v) => isPlainObject(v) && Object.values(v).every((l) => typeof l === "string" && THINKING_LEVELS.includes(l)),
    "must map model ids to valid thinking levels"
  )
};
var RETRY_RULES = [
  [["enabled"], rule((v) => typeof v === "boolean", "must be a boolean")],
  [["maxRetries"], rule(isNonNeg, "must be a non-negative integer")],
  [["maxAgentDelayMs"], rule(isNonNeg, "must be a non-negative integer")],
  [["baseDelayMs"], rule(isPosInt, "must be a positive integer")],
  [["provider", "timeoutMs"], rule(isPosInt, "must be a positive integer")],
  [["provider", "maxRetries"], rule(isNonNeg, "must be a non-negative integer")],
  [["provider", "maxRetryDelayMs"], rule(isNonNeg, "must be a non-negative integer")]
];
function validateRetryPartial(retry) {
  if (!isPlainObject(retry)) return [fieldError("retry", "retry must be an object")];
  if (retry.provider !== void 0 && !isPlainObject(retry.provider)) {
    return [fieldError("retry.provider", "retry.provider must be an object")];
  }
  const errors = [];
  for (const [path3, check] of RETRY_RULES) {
    const [head, leaf] = path3;
    const v = leaf === void 0 ? retry[head] : asObject(retry[head])[leaf];
    const msg = v === void 0 ? null : check(v);
    if (msg) errors.push(fieldError(`retry.${path3.join(".")}`, `retry.${path3.join(".")} ${msg}`));
  }
  return errors;
}
var RAW_LEGACY_TYPED = Object.freeze([
  "compaction.enabled",
  "compaction.reserveTokens",
  "compaction.keepRecentTokens",
  "branchSummary.reserveTokens",
  "branchSummary.skipPrompt",
  "steeringMode",
  "followUpMode",
  "defaultProjectTrust",
  "hideThinkingBlock",
  "quietStartup"
]);
var RAW_LEGACY_BLOCKS = ["compaction", "branchSummary"];
function validateLegacyTyped(obj) {
  const errors = [];
  for (const block of RAW_LEGACY_BLOCKS) {
    if (obj[block] !== void 0 && !isPlainObject(obj[block])) errors.push(fieldError(block, `${block} must be an object`));
  }
  for (const key of RAW_LEGACY_TYPED) {
    const [head, leaf] = key.split(".");
    const v = leaf === void 0 ? obj[head] : asObject(obj[head])[leaf];
    const def = getPiSettingDef(key);
    const msg = v === void 0 || !def ? null : checkPiSettingValue(def, v);
    if (msg) errors.push(fieldError(key, `${key} ${msg}`));
  }
  return errors;
}
function validateRawKeys(obj) {
  const errors = validateLegacyTyped(obj);
  for (const [key, check] of Object.entries(RAW_KEY_RULES)) {
    const msg = obj[key] === void 0 ? null : check(obj[key]);
    if (msg) errors.push(fieldError(key, `${key} ${msg}`));
  }
  if (obj.retry !== void 0) errors.push(...validateRetryPartial(obj.retry));
  return errors;
}
function validatePiSettingsRaw(text) {
  if (typeof text !== "string") return { ok: false, errors: [fieldError("raw", "raw must be a string")] };
  const { obj, error } = parseText(text);
  if (!obj) return { ok: false, errors: [fieldError("raw", error ?? "Invalid JSON")] };
  const errors = validateRawKeys(obj);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, obj };
}
var sameJson = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
async function writePiSettingsRaw(text, baseEtag, deps = {}) {
  const v = validatePiSettingsRaw(text);
  if (!v.ok) return { ok: false, error: "invalid", errors: v.errors };
  const r = await withPiSettingsLock(
    (state) => {
      const next = { ...v.obj };
      const restored = [];
      if (!state.parseError) {
        for (const k of PI_MANAGED_SETTINGS_KEYS) {
          const had = k in v.obj;
          const onDisk = k in state.settings;
          if (onDisk) next[k] = state.settings[k];
          else delete next[k];
          if (had !== onDisk || had && !sameJson(v.obj[k], state.settings[k])) restored.push(k);
        }
      }
      return { value: restored, write: formatJson(next) };
    },
    { baseEtag },
    deps
  );
  return toWriteResult(r, (restoredKeys) => ({ restoredKeys }));
}
function deriveMirrorWanted(cfg, keys) {
  const want = {};
  let skipped;
  const model = keys.includes("defaultModel") ? (cfg.defaultModel ?? "").trim() : "";
  if (model) {
    const slash = model.indexOf("/");
    if (slash > 0 && slash < model.length - 1) {
      want.defaultProvider = model.slice(0, slash);
      want.defaultModel = model.slice(slash + 1);
    } else {
      skipped = "no-provider-separator";
    }
  }
  const level = keys.includes("defaultThinkingLevel") ? (cfg.defaultThinkingLevel ?? "").trim() : "";
  if (THINKING_LEVELS.includes(level)) want.defaultThinkingLevel = level;
  return { want, skipped };
}
async function mirrorDefaultsToPi(readDashboardConfig, keys, deps = {}) {
  const r = await withPiSettingsLock(
    (state) => {
      const { want, skipped } = deriveMirrorWanted(readDashboardConfig(), keys);
      const changed = Object.entries(want).filter(([k, val]) => state.settings[k] !== val);
      if (changed.length === 0) return { value: { skipped } };
      if (state.parseError) return { fail: { error: "parse", parseError: state.parseError } };
      return { value: { skipped }, write: formatJson({ ...state.settings, ...Object.fromEntries(changed) }) };
    },
    {},
    deps
  );
  if (r.ok) return { ok: true, ...r.value.skipped ? { skipped: r.value.skipped } : {} };
  if (r.error === "fn") return { ok: false, error: "parse" };
  if (r.error === "stale") return { ok: false, error: "io" };
  return { ok: false, error: r.error };
}
function readPiRetryPolicy(deps = {}) {
  let state;
  try {
    state = readPiSettings(deps);
  } catch {
    return PI_RETRY_DEFAULTS;
  }
  const retry = asObject(state.settings.retry);
  const provider = asObject(retry.provider);
  const timeoutMs = typeof provider.timeoutMs === "number" && Number.isFinite(provider.timeoutMs) ? provider.timeoutMs : void 0;
  return {
    enabled: typeof retry.enabled === "boolean" ? retry.enabled : PI_RETRY_DEFAULTS.enabled,
    maxRetries: num(retry.maxRetries, PI_RETRY_DEFAULTS.maxRetries),
    baseDelayMs: num(retry.baseDelayMs, PI_RETRY_DEFAULTS.baseDelayMs),
    provider: {
      ...timeoutMs !== void 0 ? { timeoutMs } : {},
      maxRetries: num(provider.maxRetries, PI_RETRY_DEFAULTS.provider.maxRetries),
      maxRetryDelayMs: num(provider.maxRetryDelayMs, PI_RETRY_DEFAULTS.provider.maxRetryDelayMs)
    }
  };
}
function requireNonNegativeInt(v, field, errors) {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    errors.push({ field, message: `${field} must be a non-negative integer` });
  }
}
function validatePiRetryPolicy(input) {
  const errors = [];
  const p = asObject(input);
  if (typeof p.enabled !== "boolean") {
    errors.push({ field: "enabled", message: "enabled must be a boolean" });
  }
  requireNonNegativeInt(p.maxRetries, "maxRetries", errors);
  if (typeof p.baseDelayMs !== "number" || !Number.isInteger(p.baseDelayMs) || p.baseDelayMs < 1) {
    errors.push({ field: "baseDelayMs", message: "baseDelayMs must be a positive integer (ms)" });
  }
  if (!p.provider || typeof p.provider !== "object" || Array.isArray(p.provider)) {
    errors.push({ field: "provider", message: "provider must be an object" });
    return errors;
  }
  const prov = asObject(p.provider);
  if (prov.timeoutMs !== void 0) {
    if (typeof prov.timeoutMs !== "number" || !Number.isInteger(prov.timeoutMs) || prov.timeoutMs < 1) {
      errors.push({
        field: "provider.timeoutMs",
        message: "provider.timeoutMs must be a positive integer (ms) or omitted"
      });
    }
  }
  requireNonNegativeInt(prov.maxRetries, "provider.maxRetries", errors);
  requireNonNegativeInt(prov.maxRetryDelayMs, "provider.maxRetryDelayMs", errors);
  return errors;
}
async function writePiRetryPolicy(input, deps = {}) {
  const errors = validatePiRetryPolicy(input);
  if (errors.length > 0) return { ok: false, errors };
  const policy = input;
  const r = await withPiSettingsLock((state) => {
    if (state.parseError) return { fail: { error: "parse", parseError: state.parseError } };
    const existingRetry = asObject(state.settings.retry);
    const existingProvider = asObject(existingRetry.provider);
    const nextProvider = {
      ...existingProvider,
      maxRetries: policy.provider.maxRetries,
      maxRetryDelayMs: policy.provider.maxRetryDelayMs
    };
    if (policy.provider.timeoutMs === void 0) {
      delete nextProvider.timeoutMs;
    } else {
      nextProvider.timeoutMs = policy.provider.timeoutMs;
    }
    const next = {
      ...state.settings,
      retry: {
        ...existingRetry,
        enabled: policy.enabled,
        maxRetries: policy.maxRetries,
        baseDelayMs: policy.baseDelayMs,
        provider: nextProvider
      }
    };
    return { value: null, write: formatJson(next) };
  }, {}, deps);
  if (r.ok) return { ok: true, policy };
  if (r.error === "fn") return { ok: false, error: "parse" };
  if (r.error === "stale") return { ok: false, error: "io" };
  return { ok: false, error: r.error };
}
export {
  PI_RETRY_DEFAULTS,
  RAW_LEGACY_TYPED,
  applyPiSettingsPatch,
  computePiSettingsEtag,
  formatJson,
  mirrorDefaultsToPi,
  readPiRetryPolicy,
  readPiSettings,
  validatePiRetryPolicy,
  withPiSettingsLock,
  writePiRetryPolicy,
  writePiSettingsRaw
};
