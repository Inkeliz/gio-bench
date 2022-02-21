(() => {
    window.go = {argv: [], env: {}, importObject: {go: {}}};
	const argv = new URLSearchParams(location.search).get("argv");
	if (argv) {
		window.go["argv"] = argv.split(" ");
	}
})();// Copyright 2018 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

(() => {
	// Map multiple JavaScript environments to a single common API,
	// preferring web standards over Node.js API.
	//
	// Environments considered:
	// - Browsers
	// - Node.js
	// - Electron
	// - Parcel
	// - Webpack

	if (typeof global !== "undefined") {
		// global already exists
	} else if (typeof window !== "undefined") {
		window.global = window;
	} else if (typeof self !== "undefined") {
		self.global = self;
	} else {
		throw new Error("cannot export Go (neither global, window nor self is defined)");
	}

	if (!global.require && typeof require !== "undefined") {
		global.require = require;
	}

	if (!global.fs && global.require) {
		const fs = require("fs");
		if (typeof fs === "object" && fs !== null && Object.keys(fs).length !== 0) {
			global.fs = fs;
		}
	}

	const enosys = () => {
		const err = new Error("not implemented");
		err.code = "ENOSYS";
		return err;
	};

	if (!global.fs) {
		let outputBuf = "";
		global.fs = {
			constants: { O_WRONLY: -1, O_RDWR: -1, O_CREAT: -1, O_TRUNC: -1, O_APPEND: -1, O_EXCL: -1 }, // unused
			writeSync(fd, buf) {
				outputBuf += decoder.decode(buf);
				const nl = outputBuf.lastIndexOf("\n");
				if (nl != -1) {
					console.log(outputBuf.substr(0, nl));
					outputBuf = outputBuf.substr(nl + 1);
				}
				return buf.length;
			},
			write(fd, buf, offset, length, position, callback) {
				if (offset !== 0 || length !== buf.length || position !== null) {
					callback(enosys());
					return;
				}
				const n = this.writeSync(fd, buf);
				callback(null, n);
			},
			chmod(path, mode, callback) { callback(enosys()); },
			chown(path, uid, gid, callback) { callback(enosys()); },
			close(fd, callback) { callback(enosys()); },
			fchmod(fd, mode, callback) { callback(enosys()); },
			fchown(fd, uid, gid, callback) { callback(enosys()); },
			fstat(fd, callback) { callback(enosys()); },
			fsync(fd, callback) { callback(null); },
			ftruncate(fd, length, callback) { callback(enosys()); },
			lchown(path, uid, gid, callback) { callback(enosys()); },
			link(path, link, callback) { callback(enosys()); },
			lstat(path, callback) { callback(enosys()); },
			mkdir(path, perm, callback) { callback(enosys()); },
			open(path, flags, mode, callback) { callback(enosys()); },
			read(fd, buffer, offset, length, position, callback) { callback(enosys()); },
			readdir(path, callback) { callback(enosys()); },
			readlink(path, callback) { callback(enosys()); },
			rename(from, to, callback) { callback(enosys()); },
			rmdir(path, callback) { callback(enosys()); },
			stat(path, callback) { callback(enosys()); },
			symlink(path, link, callback) { callback(enosys()); },
			truncate(path, length, callback) { callback(enosys()); },
			unlink(path, callback) { callback(enosys()); },
			utimes(path, atime, mtime, callback) { callback(enosys()); },
		};
	}

	if (!global.process) {
		global.process = {
			getuid() { return -1; },
			getgid() { return -1; },
			geteuid() { return -1; },
			getegid() { return -1; },
			getgroups() { throw enosys(); },
			pid: -1,
			ppid: -1,
			umask() { throw enosys(); },
			cwd() { throw enosys(); },
			chdir() { throw enosys(); },
		}
	}

	if (!global.crypto && global.require) {
		const nodeCrypto = require("crypto");
		global.crypto = {
			getRandomValues(b) {
				nodeCrypto.randomFillSync(b);
			},
		};
	}
	if (!global.crypto) {
		throw new Error("global.crypto is not available, polyfill required (getRandomValues only)");
	}

	if (!global.performance) {
		global.performance = {
			now() {
				const [sec, nsec] = process.hrtime();
				return sec * 1000 + nsec / 1000000;
			},
		};
	}

	if (!global.TextEncoder && global.require) {
		global.TextEncoder = require("util").TextEncoder;
	}
	if (!global.TextEncoder) {
		throw new Error("global.TextEncoder is not available, polyfill required");
	}

	if (!global.TextDecoder && global.require) {
		global.TextDecoder = require("util").TextDecoder;
	}
	if (!global.TextDecoder) {
		throw new Error("global.TextDecoder is not available, polyfill required");
	}

	// End of polyfills for common API.

	const encoder = new TextEncoder("utf-8");
	const decoder = new TextDecoder("utf-8");

	global.Go = class {
		constructor() {
			this.argv = ["js"];
			this.env = {};
			this.exit = (code) => {
				if (code !== 0) {
					console.warn("exit code:", code);
				}
			};
			this._exitPromise = new Promise((resolve) => {
				this._resolveExitPromise = resolve;
			});
			this._pendingEvent = null;
			this._scheduledTimeouts = new Map();
			this._nextCallbackTimeoutID = 1;

			const setInt64 = (addr, v) => {
				this.mem.setUint32(addr + 0, v, true);
				this.mem.setUint32(addr + 4, Math.floor(v / 4294967296), true);
			}

			const getInt64 = (addr) => {
				const low = this.mem.getUint32(addr + 0, true);
				const high = this.mem.getInt32(addr + 4, true);
				return low + high * 4294967296;
			}

			const loadValue = (addr) => {
				const f = this.mem.getFloat64(addr, true);
				if (f === 0) {
					return undefined;
				}
				if (!isNaN(f)) {
					return f;
				}

				const id = this.mem.getUint32(addr, true);
				return this._values[id];
			}

			const storeValue = (addr, v) => {
				const nanHead = 0x7FF80000;

				if (typeof v === "number" && v !== 0) {
					if (isNaN(v)) {
						this.mem.setUint32(addr + 4, nanHead, true);
						this.mem.setUint32(addr, 0, true);
						return;
					}
					this.mem.setFloat64(addr, v, true);
					return;
				}

				if (v === undefined) {
					this.mem.setFloat64(addr, 0, true);
					return;
				}

				let id = this._ids.get(v);
				if (id === undefined) {
					id = this._idPool.pop();
					if (id === undefined) {
						id = this._values.length;
					}
					this._values[id] = v;
					this._goRefCounts[id] = 0;
					this._ids.set(v, id);
				}
				this._goRefCounts[id]++;
				let typeFlag = 0;
				switch (typeof v) {
					case "object":
						if (v !== null) {
							typeFlag = 1;
						}
						break;
					case "string":
						typeFlag = 2;
						break;
					case "symbol":
						typeFlag = 3;
						break;
					case "function":
						typeFlag = 4;
						break;
				}
				this.mem.setUint32(addr + 4, nanHead | typeFlag, true);
				this.mem.setUint32(addr, id, true);
			}

			const loadSlice = (addr) => {
				const array = getInt64(addr + 0);
				const len = getInt64(addr + 8);
				return new Uint8Array(this._inst.exports.mem.buffer, array, len);
			}

			const loadSliceOfValues = (addr) => {
				const array = getInt64(addr + 0);
				const len = getInt64(addr + 8);
				const a = new Array(len);
				for (let i = 0; i < len; i++) {
					a[i] = loadValue(array + i * 8);
				}
				return a;
			}

			const loadString = (addr) => {
				const saddr = getInt64(addr + 0);
				const len = getInt64(addr + 8);
				return decoder.decode(new DataView(this._inst.exports.mem.buffer, saddr, len));
			}

			const timeOrigin = Date.now() - performance.now();
			this.importObject = {
				go: {
					// Go's SP does not change as long as no Go code is running. Some operations (e.g. calls, getters and setters)
					// may synchronously trigger a Go event handler. This makes Go code get executed in the middle of the imported
					// function. A goroutine can switch to a new stack if the current stack is too small (see morestack function).
					// This changes the SP, thus we have to update the SP used by the imported function.

					// func wasmExit(code int32)
					"runtime.wasmExit": (sp) => {
						sp >>>= 0;
						const code = this.mem.getInt32(sp + 8, true);
						this.exited = true;
						delete this._inst;
						delete this._values;
						delete this._goRefCounts;
						delete this._ids;
						delete this._idPool;
						this.exit(code);
					},

					// func wasmWrite(fd uintptr, p unsafe.Pointer, n int32)
					"runtime.wasmWrite": (sp) => {
						sp >>>= 0;
						const fd = getInt64(sp + 8);
						const p = getInt64(sp + 16);
						const n = this.mem.getInt32(sp + 24, true);
						fs.writeSync(fd, new Uint8Array(this._inst.exports.mem.buffer, p, n));
					},

					// func resetMemoryDataView()
					"runtime.resetMemoryDataView": (sp) => {
						sp >>>= 0;
						this.mem = new DataView(this._inst.exports.mem.buffer);
					},

					// func nanotime1() int64
					"runtime.nanotime1": (sp) => {
						sp >>>= 0;
						setInt64(sp + 8, (timeOrigin + performance.now()) * 1000000);
					},

					// func walltime() (sec int64, nsec int32)
					"runtime.walltime": (sp) => {
						sp >>>= 0;
						const msec = (new Date).getTime();
						setInt64(sp + 8, msec / 1000);
						this.mem.setInt32(sp + 16, (msec % 1000) * 1000000, true);
					},

					// func scheduleTimeoutEvent(delay int64) int32
					"runtime.scheduleTimeoutEvent": (sp) => {
						sp >>>= 0;
						const id = this._nextCallbackTimeoutID;
						this._nextCallbackTimeoutID++;
						this._scheduledTimeouts.set(id, setTimeout(
							() => {
								this._resume();
								while (this._scheduledTimeouts.has(id)) {
									// for some reason Go failed to register the timeout event, log and try again
									// (temporary workaround for https://github.com/golang/go/issues/28975)
									console.warn("scheduleTimeoutEvent: missed timeout event");
									this._resume();
								}
							},
							getInt64(sp + 8) + 1, // setTimeout has been seen to fire up to 1 millisecond early
						));
						this.mem.setInt32(sp + 16, id, true);
					},

					// func clearTimeoutEvent(id int32)
					"runtime.clearTimeoutEvent": (sp) => {
						sp >>>= 0;
						const id = this.mem.getInt32(sp + 8, true);
						clearTimeout(this._scheduledTimeouts.get(id));
						this._scheduledTimeouts.delete(id);
					},

					// func getRandomData(r []byte)
					"runtime.getRandomData": (sp) => {
						sp >>>= 0;
						crypto.getRandomValues(loadSlice(sp + 8));
					},

					// func finalizeRef(v ref)
					"syscall/js.finalizeRef": (sp) => {
						sp >>>= 0;
						const id = this.mem.getUint32(sp + 8, true);
						this._goRefCounts[id]--;
						if (this._goRefCounts[id] === 0) {
							const v = this._values[id];
							this._values[id] = null;
							this._ids.delete(v);
							this._idPool.push(id);
						}
					},

					// func stringVal(value string) ref
					"syscall/js.stringVal": (sp) => {
						sp >>>= 0;
						storeValue(sp + 24, loadString(sp + 8));
					},

					// func valueGet(v ref, p string) ref
					"syscall/js.valueGet": (sp) => {
						sp >>>= 0;
						const result = Reflect.get(loadValue(sp + 8), loadString(sp + 16));
						sp = this._inst.exports.getsp() >>> 0; // see comment above
						storeValue(sp + 32, result);
					},

					// func valueSet(v ref, p string, x ref)
					"syscall/js.valueSet": (sp) => {
						sp >>>= 0;
						Reflect.set(loadValue(sp + 8), loadString(sp + 16), loadValue(sp + 32));
					},

					// func valueDelete(v ref, p string)
					"syscall/js.valueDelete": (sp) => {
						sp >>>= 0;
						Reflect.deleteProperty(loadValue(sp + 8), loadString(sp + 16));
					},

					// func valueIndex(v ref, i int) ref
					"syscall/js.valueIndex": (sp) => {
						sp >>>= 0;
						storeValue(sp + 24, Reflect.get(loadValue(sp + 8), getInt64(sp + 16)));
					},

					// valueSetIndex(v ref, i int, x ref)
					"syscall/js.valueSetIndex": (sp) => {
						sp >>>= 0;
						Reflect.set(loadValue(sp + 8), getInt64(sp + 16), loadValue(sp + 24));
					},

					// func valueCall(v ref, m string, args []ref) (ref, bool)
					"syscall/js.valueCall": (sp) => {
						sp >>>= 0;
						try {
							const v = loadValue(sp + 8);
							const m = Reflect.get(v, loadString(sp + 16));
							const args = loadSliceOfValues(sp + 32);
							const result = Reflect.apply(m, v, args);
							sp = this._inst.exports.getsp() >>> 0; // see comment above
							storeValue(sp + 56, result);
							this.mem.setUint8(sp + 64, 1);
						} catch (err) {
							sp = this._inst.exports.getsp() >>> 0; // see comment above
							storeValue(sp + 56, err);
							this.mem.setUint8(sp + 64, 0);
						}
					},

					// func valueInvoke(v ref, args []ref) (ref, bool)
					"syscall/js.valueInvoke": (sp) => {
						sp >>>= 0;
						try {
							const v = loadValue(sp + 8);
							const args = loadSliceOfValues(sp + 16);
							const result = Reflect.apply(v, undefined, args);
							sp = this._inst.exports.getsp() >>> 0; // see comment above
							storeValue(sp + 40, result);
							this.mem.setUint8(sp + 48, 1);
						} catch (err) {
							sp = this._inst.exports.getsp() >>> 0; // see comment above
							storeValue(sp + 40, err);
							this.mem.setUint8(sp + 48, 0);
						}
					},

					// func valueNew(v ref, args []ref) (ref, bool)
					"syscall/js.valueNew": (sp) => {
						sp >>>= 0;
						try {
							const v = loadValue(sp + 8);
							const args = loadSliceOfValues(sp + 16);
							const result = Reflect.construct(v, args);
							sp = this._inst.exports.getsp() >>> 0; // see comment above
							storeValue(sp + 40, result);
							this.mem.setUint8(sp + 48, 1);
						} catch (err) {
							sp = this._inst.exports.getsp() >>> 0; // see comment above
							storeValue(sp + 40, err);
							this.mem.setUint8(sp + 48, 0);
						}
					},

					// func valueLength(v ref) int
					"syscall/js.valueLength": (sp) => {
						sp >>>= 0;
						setInt64(sp + 16, parseInt(loadValue(sp + 8).length));
					},

					// valuePrepareString(v ref) (ref, int)
					"syscall/js.valuePrepareString": (sp) => {
						sp >>>= 0;
						const str = encoder.encode(String(loadValue(sp + 8)));
						storeValue(sp + 16, str);
						setInt64(sp + 24, str.length);
					},

					// valueLoadString(v ref, b []byte)
					"syscall/js.valueLoadString": (sp) => {
						sp >>>= 0;
						const str = loadValue(sp + 8);
						loadSlice(sp + 16).set(str);
					},

					// func valueInstanceOf(v ref, t ref) bool
					"syscall/js.valueInstanceOf": (sp) => {
						sp >>>= 0;
						this.mem.setUint8(sp + 24, (loadValue(sp + 8) instanceof loadValue(sp + 16)) ? 1 : 0);
					},

					// func copyBytesToGo(dst []byte, src ref) (int, bool)
					"syscall/js.copyBytesToGo": (sp) => {
						sp >>>= 0;
						const dst = loadSlice(sp + 8);
						const src = loadValue(sp + 32);
						if (!(src instanceof Uint8Array || src instanceof Uint8ClampedArray)) {
							this.mem.setUint8(sp + 48, 0);
							return;
						}
						const toCopy = src.subarray(0, dst.length);
						dst.set(toCopy);
						setInt64(sp + 40, toCopy.length);
						this.mem.setUint8(sp + 48, 1);
					},

					// func copyBytesToJS(dst ref, src []byte) (int, bool)
					"syscall/js.copyBytesToJS": (sp) => {
						sp >>>= 0;
						const dst = loadValue(sp + 8);
						const src = loadSlice(sp + 16);
						if (!(dst instanceof Uint8Array || dst instanceof Uint8ClampedArray)) {
							this.mem.setUint8(sp + 48, 0);
							return;
						}
						const toCopy = src.subarray(0, dst.length);
						dst.set(toCopy);
						setInt64(sp + 40, toCopy.length);
						this.mem.setUint8(sp + 48, 1);
					},

					"debug": (value) => {
						console.log(value);
					},
				}
			};
		}

		async run(instance) {
			if (!(instance instanceof WebAssembly.Instance)) {
				throw new Error("Go.run: WebAssembly.Instance expected");
			}
			this._inst = instance;
			this.mem = new DataView(this._inst.exports.mem.buffer);
			this._values = [ // JS values that Go currently has references to, indexed by reference id
				NaN,
				0,
				null,
				true,
				false,
				global,
				this,
			];
			this._goRefCounts = new Array(this._values.length).fill(Infinity); // number of references that Go has to a JS value, indexed by reference id
			this._ids = new Map([ // mapping from JS values to reference ids
				[0, 1],
				[null, 2],
				[true, 3],
				[false, 4],
				[global, 5],
				[this, 6],
			]);
			this._idPool = [];   // unused ids that have been garbage collected
			this.exited = false; // whether the Go program has exited

			// Pass command line arguments and environment variables to WebAssembly by writing them to the linear memory.
			let offset = 4096;

			const strPtr = (str) => {
				const ptr = offset;
				const bytes = encoder.encode(str + "\0");
				new Uint8Array(this.mem.buffer, offset, bytes.length).set(bytes);
				offset += bytes.length;
				if (offset % 8 !== 0) {
					offset += 8 - (offset % 8);
				}
				return ptr;
			};

			const argc = this.argv.length;

			const argvPtrs = [];
			this.argv.forEach((arg) => {
				argvPtrs.push(strPtr(arg));
			});
			argvPtrs.push(0);

			const keys = Object.keys(this.env).sort();
			keys.forEach((key) => {
				argvPtrs.push(strPtr(`${key}=${this.env[key]}`));
			});
			argvPtrs.push(0);

			const argv = offset;
			argvPtrs.forEach((ptr) => {
				this.mem.setUint32(offset, ptr, true);
				this.mem.setUint32(offset + 4, 0, true);
				offset += 8;
			});

			// The linker guarantees global data starts from at least wasmMinDataAddr.
			// Keep in sync with cmd/link/internal/ld/data.go:wasmMinDataAddr.
			const wasmMinDataAddr = 4096 + 8192;
			if (offset >= wasmMinDataAddr) {
				throw new Error("total length of command line and environment variables exceeds limit");
			}

			this._inst.exports.run(argc, argv);
			if (this.exited) {
				this._resolveExitPromise();
			}
			await this._exitPromise;
		}

		_resume() {
			if (this.exited) {
				throw new Error("Go program has already exited");
			}
			this._inst.exports.resume();
			if (this.exited) {
				this._resolveExitPromise();
			}
		}

		_makeFuncWrapper(id) {
			const go = this;
			return function () {
				const event = { id: id, this: this, args: arguments };
				go._pendingEvent = event;
				go._resume();
				return event.result;
			};
		}
	}

	if (
		typeof module !== "undefined" &&
		global.require &&
		global.require.main === module &&
		global.process &&
		global.process.versions &&
		!global.process.versions.electron
	) {
		if (process.argv.length < 3) {
			console.error("usage: go_js_wasm_exec [wasm binary] [arguments]");
			process.exit(1);
		}

		const go = new Go();
		go.argv = process.argv.slice(2);
		go.env = Object.assign({ TMPDIR: require("os").tmpdir() }, process.env);
		go.exit = process.exit;
		WebAssembly.instantiate(fs.readFileSync(process.argv[2]), go.importObject).then((result) => {
			process.on("exit", (code) => { // Node.js exits if no event handler is pending
				if (code === 0 && !go.exited) {
					// deadlock, make Go print error and stack traces
					go._pendingEvent = { id: 0 };
					go._resume();
				}
			});
			return go.run(result.instance);
		}).catch((err) => {
			console.error(err);
			process.exit(1);
		});
	}
})();
// Code generated by INKWASM BUILD; DO NOT EDIT
(() => {

})();
// Code generated by INKWASM BUILD; DO NOT EDIT
(() => {
	Object.assign(go.importObject.go, {

		"gioui.org/internal/gl.__asmGetExtension": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).getExtension(globalThis.inkwasm.Load.String(go, sp, 24))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.InkwasmObject(go, sp, 40, r)
		},

		"gioui.org/internal/gl.__asmActiveTexture": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).activeTexture(globalThis.inkwasm.Load.Uint(go, sp, 24))

		},

		"gioui.org/internal/gl.__asmAttachShader": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).attachShader(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24),globalThis.inkwasm.Load.InkwasmObject(go, sp, 40))

		},

		"gioui.org/internal/gl.__asmBeginQuery": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).beginQuery(globalThis.inkwasm.Load.Uint(go, sp, 24),globalThis.inkwasm.Load.InkwasmObject(go, sp, 32))

		},

		"gioui.org/internal/gl.__asmBindAttribLocation": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).bindAttribLocation(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24),globalThis.inkwasm.Load.Uint(go, sp, 40),globalThis.inkwasm.Load.String(go, sp, 48))

		},

		"gioui.org/internal/gl.__asmBindBuffer": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).bindBuffer(globalThis.inkwasm.Load.Uint(go, sp, 24),globalThis.inkwasm.Load.InkwasmObject(go, sp, 32))

		},

		"gioui.org/internal/gl.__asmBindBufferBase": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).bindBufferBase(globalThis.inkwasm.Load.Uint(go, sp, 24),globalThis.inkwasm.Load.Int(go, sp, 32),globalThis.inkwasm.Load.InkwasmObject(go, sp, 40))

		},

		"gioui.org/internal/gl.__asmBindFramebuffer": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).bindFramebuffer(globalThis.inkwasm.Load.Uint(go, sp, 24),globalThis.inkwasm.Load.InkwasmObject(go, sp, 32))

		},

		"gioui.org/internal/gl.__asmBindRenderbuffer": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).bindRenderbuffer(globalThis.inkwasm.Load.Uint(go, sp, 24),globalThis.inkwasm.Load.InkwasmObject(go, sp, 32))

		},

		"gioui.org/internal/gl.__asmBindTexture": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).bindTexture(globalThis.inkwasm.Load.Uint(go, sp, 24),globalThis.inkwasm.Load.InkwasmObject(go, sp, 32))

		},

		"gioui.org/internal/gl.__asmBlendEquation": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).blendEquation(globalThis.inkwasm.Load.Uint(go, sp, 24))

		},

		"gioui.org/internal/gl.__asmBlendFuncSeparate": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).blendFunc(globalThis.inkwasm.Load.Uint(go, sp, 24),globalThis.inkwasm.Load.Uint(go, sp, 32),globalThis.inkwasm.Load.Uint(go, sp, 40),globalThis.inkwasm.Load.Uint(go, sp, 48))

		},

		"gioui.org/internal/gl.__asmBufferDataSize": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).bufferData(globalThis.inkwasm.Load.Uint(go, sp, 24),globalThis.inkwasm.Load.Int(go, sp, 32),globalThis.inkwasm.Load.Uint(go, sp, 40))

		},

		"gioui.org/internal/gl.__asmBufferData": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).bufferData(globalThis.inkwasm.Load.Uint(go, sp, 24),globalThis.inkwasm.Load.Slice(go, sp, 32, globalThis.inkwasm.Load.ArrayByte),globalThis.inkwasm.Load.Uint(go, sp, 56))

		},

		"gioui.org/internal/gl.__asmBufferSubData": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).bufferSubData(globalThis.inkwasm.Load.Uint(go, sp, 24),globalThis.inkwasm.Load.Int(go, sp, 32),globalThis.inkwasm.Load.Slice(go, sp, 40, globalThis.inkwasm.Load.ArrayByte))

		},

		"gioui.org/internal/gl.__asmCheckFramebufferStatus": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).checkFramebufferStatus(globalThis.inkwasm.Load.Uint(go, sp, 24))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.Uint(go, sp, 32, r)
		},

		"gioui.org/internal/gl.__asmClear": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).clear(globalThis.inkwasm.Load.Uint(go, sp, 24))

		},

		"gioui.org/internal/gl.__asmClearColor": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).clearColor(globalThis.inkwasm.Load.Float64(go, sp, 24),globalThis.inkwasm.Load.Float64(go, sp, 32),globalThis.inkwasm.Load.Float64(go, sp, 40),globalThis.inkwasm.Load.Float64(go, sp, 48))

		},

		"gioui.org/internal/gl.__asmClearDepthf": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).clearDepth(globalThis.inkwasm.Load.Float64(go, sp, 24))

		},

		"gioui.org/internal/gl.__asmCompileShader": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).compileShader(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24))

		},

		"gioui.org/internal/gl.__asmCopyTexSubImage2D": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).copyTexSubImage2D(globalThis.inkwasm.Load.Uint(go, sp, 24),globalThis.inkwasm.Load.Int(go, sp, 32),globalThis.inkwasm.Load.Int(go, sp, 40),globalThis.inkwasm.Load.Int(go, sp, 48),globalThis.inkwasm.Load.Int(go, sp, 56),globalThis.inkwasm.Load.Int(go, sp, 64),globalThis.inkwasm.Load.Int(go, sp, 72),globalThis.inkwasm.Load.Int(go, sp, 80))

		},

		"gioui.org/internal/gl.__asmCreateBuffer": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).createBuffer()
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.InkwasmObject(go, sp, 24, r)
		},

		"gioui.org/internal/gl.__asmCreateFramebuffer": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).createFramebuffer()
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.InkwasmObject(go, sp, 24, r)
		},

		"gioui.org/internal/gl.__asmCreateProgram": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).createProgram()
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.InkwasmObject(go, sp, 24, r)
		},

		"gioui.org/internal/gl.__asmCreateQuery": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).createQuery()
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.InkwasmObject(go, sp, 24, r)
		},

		"gioui.org/internal/gl.__asmCreateRenderbuffer": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).createRenderbuffer()
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.InkwasmObject(go, sp, 24, r)
		},

		"gioui.org/internal/gl.__asmCreateShader": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).createShader(globalThis.inkwasm.Load.Uint(go, sp, 24))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.InkwasmObject(go, sp, 32, r)
		},

		"gioui.org/internal/gl.__asmCreateTexture": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).createTexture()
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.InkwasmObject(go, sp, 24, r)
		},

		"gioui.org/internal/gl.__asmDeleteBuffer": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).deleteBuffer(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24))

		},

		"gioui.org/internal/gl.__asmDeleteFramebuffer": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).deleteFramebuffer(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24))

		},

		"gioui.org/internal/gl.__asmDeleteProgram": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).deleteProgram(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24))

		},

		"gioui.org/internal/gl.__asmDeleteQuery": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).deleteQuery(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24))

		},

		"gioui.org/internal/gl.__asmDeleteShader": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).deleteShader(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24))

		},

		"gioui.org/internal/gl.__asmDeleteRenderbuffer": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).deleteRenderbuffer(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24))

		},

		"gioui.org/internal/gl.__asmDeleteTexture": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).deleteTexture(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24))

		},

		"gioui.org/internal/gl.__asmDepthFunc": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).depthFunc(globalThis.inkwasm.Load.Uint(go, sp, 24))

		},

		"gioui.org/internal/gl.__asmDepthMask": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).depthMask(globalThis.inkwasm.Load.Bool(go, sp, 24))

		},

		"gioui.org/internal/gl.__asmDisableVertexAttribArray": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).disableVertexAttribArray(globalThis.inkwasm.Load.Uint(go, sp, 24))

		},

		"gioui.org/internal/gl.__asmDisable": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).disable(globalThis.inkwasm.Load.Uint(go, sp, 24))

		},

		"gioui.org/internal/gl.__asmDrawArrays": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).drawArrays(globalThis.inkwasm.Load.Uint(go, sp, 24),globalThis.inkwasm.Load.Int(go, sp, 32),globalThis.inkwasm.Load.Int(go, sp, 40))

		},

		"gioui.org/internal/gl.__asmDrawElements": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).drawElements(globalThis.inkwasm.Load.Uint(go, sp, 24),globalThis.inkwasm.Load.Int(go, sp, 32),globalThis.inkwasm.Load.Uint(go, sp, 40),globalThis.inkwasm.Load.Int(go, sp, 48))

		},

		"gioui.org/internal/gl.__asmEnable": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).enable(globalThis.inkwasm.Load.Uint(go, sp, 24))

		},

		"gioui.org/internal/gl.__asmEnableVertexAttribArray": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).enableVertexAttribArray(globalThis.inkwasm.Load.Uint(go, sp, 24))

		},

		"gioui.org/internal/gl.__asmEndQuery": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).endQuery(globalThis.inkwasm.Load.Uint(go, sp, 24))

		},

		"gioui.org/internal/gl.__asmFinish": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).finish()

		},

		"gioui.org/internal/gl.__asmFlush": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).flush()

		},

		"gioui.org/internal/gl.__asmFramebufferRenderbuffer": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).framebufferRenderbuffer(globalThis.inkwasm.Load.Uint(go, sp, 24),globalThis.inkwasm.Load.Uint(go, sp, 32),globalThis.inkwasm.Load.Uint(go, sp, 40),globalThis.inkwasm.Load.InkwasmObject(go, sp, 48))

		},

		"gioui.org/internal/gl.__asmFramebufferTexture2D": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).framebufferTexture2D(globalThis.inkwasm.Load.Uint(go, sp, 24),globalThis.inkwasm.Load.Uint(go, sp, 32),globalThis.inkwasm.Load.Uint(go, sp, 40),globalThis.inkwasm.Load.InkwasmObject(go, sp, 48),globalThis.inkwasm.Load.Int(go, sp, 64))

		},

		"gioui.org/internal/gl.__asmGetRenderbufferParameteri": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).getRenderbufferParameteri(globalThis.inkwasm.Load.Uint(go, sp, 24))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.Int(go, sp, 32, r)
		},

		"gioui.org/internal/gl.__asmGetFramebufferAttachmentParameteri": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).getFramebufferAttachmentParameter(globalThis.inkwasm.Load.Uint(go, sp, 24),globalThis.inkwasm.Load.Uint(go, sp, 32),globalThis.inkwasm.Load.Uint(go, sp, 40))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.Int(go, sp, 48, r)
		},

		"gioui.org/internal/gl.__asmGetParameter": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).getParameter(globalThis.inkwasm.Load.Uint(go, sp, 24))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.String(go, sp, 32, r)
		},

		"gioui.org/internal/gl.__asmGetBinding": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).getParameter(globalThis.inkwasm.Load.Uint(go, sp, 24))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.InkwasmObject(go, sp, 32, r)
		},

		"gioui.org/internal/gl.__asmGetBindingi": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).getIndexedParameter(globalThis.inkwasm.Load.Uint(go, sp, 24),globalThis.inkwasm.Load.Int(go, sp, 32))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.InkwasmObject(go, sp, 40, r)
		},

		"gioui.org/internal/gl.__asmGetInteger": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).getParameter(globalThis.inkwasm.Load.Uint(go, sp, 24))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.Int(go, sp, 32, r)
		},

		"gioui.org/internal/gl.__asmGetFloat": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).getParameter(globalThis.inkwasm.Load.Uint(go, sp, 24))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.Float32(go, sp, 32, r)
		},

		"gioui.org/internal/gl.__asmGetInteger4": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).getParameter(globalThis.inkwasm.Load.Uint(go, sp, 24))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.Array(go, sp, 32, r, 4, 8, globalThis.inkwasm.Set.Int)
		},

		"gioui.org/internal/gl.__asmGetFloat4": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).getParameter(globalThis.inkwasm.Load.Uint(go, sp, 24))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.Array(go, sp, 32, r, 4, 4, globalThis.inkwasm.Set.Float32)
		},

		"gioui.org/internal/gl.__asmGetProgrami": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).getProgramParameter(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24),globalThis.inkwasm.Load.Uint(go, sp, 40))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.Int(go, sp, 48, r)
		},

		"gioui.org/internal/gl.__asmGetProgramInfoLog": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).getProgramInfoLog(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.String(go, sp, 40, r)
		},

		"gioui.org/internal/gl.__asmGetQueryObjectuiv": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).getQueryParameter(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24),globalThis.inkwasm.Load.Uint(go, sp, 40))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.Uint(go, sp, 48, r)
		},

		"gioui.org/internal/gl.__asmGetShaderi": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).getShaderParameter(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24),globalThis.inkwasm.Load.Uint(go, sp, 40))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.Int(go, sp, 48, r)
		},

		"gioui.org/internal/gl.__asmGetShaderInfoLog": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).getShaderInfoLog(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.String(go, sp, 40, r)
		},

		"gioui.org/internal/gl.__asmGetSupportedExtensions": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).getSupportedExtensions()
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.InkwasmObject(go, sp, 24, r)
		},

		"gioui.org/internal/gl.__asmGetUniformBlockIndex": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).getUniformBlockIndex(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24),globalThis.inkwasm.Load.String(go, sp, 40))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.Uint(go, sp, 56, r)
		},

		"gioui.org/internal/gl.__asmGetUniformLocation": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).getUniformLocation(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24),globalThis.inkwasm.Load.String(go, sp, 40))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.InkwasmObject(go, sp, 56, r)
		},

		"gioui.org/internal/gl.__asmGetVertexAttrib": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).getVertexAttrib(globalThis.inkwasm.Load.Int(go, sp, 24),globalThis.inkwasm.Load.Uint(go, sp, 32))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.Int(go, sp, 40, r)
		},

		"gioui.org/internal/gl.__asmGetVertexAttribBinding": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).getVertexAttrib(globalThis.inkwasm.Load.Int(go, sp, 24),globalThis.inkwasm.Load.Uint(go, sp, 32))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.InkwasmObject(go, sp, 40, r)
		},

		"gioui.org/internal/gl.__asmGetVertexAttribPointer": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).getVertexAttribOffset(globalThis.inkwasm.Load.Int(go, sp, 24),globalThis.inkwasm.Load.Uint(go, sp, 32))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.UintPtr(go, sp, 40, r)
		},

		"gioui.org/internal/gl.__asmInvalidateFramebuffer": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).invalidateFramebuffer(globalThis.inkwasm.Load.Uint(go, sp, 24),globalThis.inkwasm.Load.Array(go, sp, 32, 1, globalThis.inkwasm.Load.ArrayInt32))

		},

		"gioui.org/internal/gl.__asmIsEnabled": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).isEnabled(globalThis.inkwasm.Load.Uint(go, sp, 24))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.Bool(go, sp, 32, r)
		},

		"gioui.org/internal/gl.__asmLinkProgram": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).linkProgram(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24))

		},

		"gioui.org/internal/gl.__asmPixelStorei": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).pixelStorei(globalThis.inkwasm.Load.Uint(go, sp, 24),globalThis.inkwasm.Load.Int(go, sp, 32))

		},

		"gioui.org/internal/gl.__asmRenderbufferStorage": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).renderbufferStorage(globalThis.inkwasm.Load.Uint(go, sp, 24),globalThis.inkwasm.Load.Uint(go, sp, 32),globalThis.inkwasm.Load.Int(go, sp, 40),globalThis.inkwasm.Load.Int(go, sp, 48))

		},

		"gioui.org/internal/gl.__asmReadPixels": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).readPixels(globalThis.inkwasm.Load.Int(go, sp, 24),globalThis.inkwasm.Load.Int(go, sp, 32),globalThis.inkwasm.Load.Int(go, sp, 40),globalThis.inkwasm.Load.Int(go, sp, 48),globalThis.inkwasm.Load.Uint(go, sp, 56),globalThis.inkwasm.Load.Uint(go, sp, 64),globalThis.inkwasm.Load.Slice(go, sp, 72, globalThis.inkwasm.Load.ArrayByte))

		},

		"gioui.org/internal/gl.__asmScissor": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).scissor(globalThis.inkwasm.Load.Int32(go, sp, 24),globalThis.inkwasm.Load.Int32(go, sp, 28),globalThis.inkwasm.Load.Int32(go, sp, 32),globalThis.inkwasm.Load.Int32(go, sp, 36))

		},

		"gioui.org/internal/gl.__asmShaderSource": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).shaderSource(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24),globalThis.inkwasm.Load.String(go, sp, 40))

		},

		"gioui.org/internal/gl.__asmTexImage2D": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).texImage2D(globalThis.inkwasm.Load.Uint(go, sp, 24),globalThis.inkwasm.Load.Int(go, sp, 32),globalThis.inkwasm.Load.Uint(go, sp, 40),globalThis.inkwasm.Load.Int(go, sp, 48),globalThis.inkwasm.Load.Int(go, sp, 56),globalThis.inkwasm.Load.Uint(go, sp, 64),globalThis.inkwasm.Load.Uint(go, sp, 72),globalThis.inkwasm.Load.Uint(go, sp, 80),globalThis.inkwasm.Load.InkwasmObject(go, sp, 88))

		},

		"gioui.org/internal/gl.__asmTexStorage2D": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).texStorage2D(globalThis.inkwasm.Load.Uint(go, sp, 24),globalThis.inkwasm.Load.Int(go, sp, 32),globalThis.inkwasm.Load.Uint(go, sp, 40),globalThis.inkwasm.Load.Int(go, sp, 48),globalThis.inkwasm.Load.Int(go, sp, 56))

		},

		"gioui.org/internal/gl.__asmTexSubImage2D": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).texSubImage2D(globalThis.inkwasm.Load.Uint(go, sp, 24),globalThis.inkwasm.Load.Int(go, sp, 32),globalThis.inkwasm.Load.Int(go, sp, 40),globalThis.inkwasm.Load.Int(go, sp, 48),globalThis.inkwasm.Load.Int(go, sp, 56),globalThis.inkwasm.Load.Int(go, sp, 64),globalThis.inkwasm.Load.Uint(go, sp, 72),globalThis.inkwasm.Load.Uint(go, sp, 80),globalThis.inkwasm.Load.Slice(go, sp, 88, globalThis.inkwasm.Load.ArrayByte))

		},

		"gioui.org/internal/gl.__asmTexParameteri": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).texParameteri(globalThis.inkwasm.Load.Uint(go, sp, 24),globalThis.inkwasm.Load.Uint(go, sp, 32),globalThis.inkwasm.Load.Int(go, sp, 40))

		},

		"gioui.org/internal/gl.__asmUniformBlockBinding": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).uniformBlockBinding(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24),globalThis.inkwasm.Load.Uint(go, sp, 40),globalThis.inkwasm.Load.Uint(go, sp, 48))

		},

		"gioui.org/internal/gl.__asmUniform1f": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).uniform1f(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24),globalThis.inkwasm.Load.Float32(go, sp, 40))

		},

		"gioui.org/internal/gl.__asmUniform1i": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).uniform1i(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24),globalThis.inkwasm.Load.Int(go, sp, 40))

		},

		"gioui.org/internal/gl.__asmUniform2f": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).uniform2f(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24),globalThis.inkwasm.Load.Float32(go, sp, 40),globalThis.inkwasm.Load.Float32(go, sp, 44))

		},

		"gioui.org/internal/gl.__asmUniform3f": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).uniform3f(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24),globalThis.inkwasm.Load.Float32(go, sp, 40),globalThis.inkwasm.Load.Float32(go, sp, 44),globalThis.inkwasm.Load.Float32(go, sp, 48))

		},

		"gioui.org/internal/gl.__asmUniform4f": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).uniform4f(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24),globalThis.inkwasm.Load.Float32(go, sp, 40),globalThis.inkwasm.Load.Float32(go, sp, 44),globalThis.inkwasm.Load.Float32(go, sp, 48),globalThis.inkwasm.Load.Float32(go, sp, 52))

		},

		"gioui.org/internal/gl.__asmUseProgram": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).useProgram(globalThis.inkwasm.Load.InkwasmObject(go, sp, 24))

		},

		"gioui.org/internal/gl.__asmVertexAttribPointer": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).vertexAttribPointer(globalThis.inkwasm.Load.Uint(go, sp, 24),globalThis.inkwasm.Load.Int(go, sp, 32),globalThis.inkwasm.Load.Uint(go, sp, 40),globalThis.inkwasm.Load.Bool(go, sp, 48),globalThis.inkwasm.Load.Int(go, sp, 56),globalThis.inkwasm.Load.Int(go, sp, 64))

		},

		"gioui.org/internal/gl.__asmViewport": (sp) => {
			globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).viewport(globalThis.inkwasm.Load.Int(go, sp, 24),globalThis.inkwasm.Load.Int(go, sp, 32),globalThis.inkwasm.Load.Int(go, sp, 40),globalThis.inkwasm.Load.Int(go, sp, 48))

		},

	})
})();
// Code generated by INKWASM BUILD; DO NOT EDIT
(() => {

})();
// Code generated by INKWASM BUILD; DO NOT EDIT
(() => {
	Object.assign(go.importObject.go, {

		"github.com/inkeliz/go_inkwasm/inkwasm.__getBasicDecoder": (sp) => {
			let r = globalThis.inkwasm.Load[globalThis.inkwasm.Load.String(go, sp, 8)]
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.InkwasmObject(go, sp, 24, r)
		},

		"github.com/inkeliz/go_inkwasm/inkwasm.__getSliceDecoder": (sp) => {
			let r = globalThis.inkwasm.Load.SliceOf(globalThis.inkwasm.Load.InkwasmObject(go, sp, 8))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.InkwasmObject(go, sp, 24, r)
		},

		"github.com/inkeliz/go_inkwasm/inkwasm.__newObjectFromSyscall": (sp) => {
			let r = go._values[globalThis.inkwasm.Load.Uint32(go, sp, 8)]
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.InkwasmObject(go, sp, 16, r)
		},

		"github.com/inkeliz/go_inkwasm/inkwasm.__getNull": (sp) => {
			let r = null
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.InkwasmObject(go, sp, 8, r)
		},

		"github.com/inkeliz/go_inkwasm/inkwasm.__getUndefined": (sp) => {
			let r = undefined
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.InkwasmObject(go, sp, 8, r)
		},

		"github.com/inkeliz/go_inkwasm/inkwasm.__getGlobal": (sp) => {
			let r = globalThis
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.InkwasmObject(go, sp, 8, r)
		},

		"github.com/inkeliz/go_inkwasm/inkwasm.__makeObj": (sp) => {
			let r = globalThis.inkwasm.Internal.Make(globalThis.inkwasm.Load.Slice(go, sp, 8, globalThis.inkwasm.Load.ArrayInt32))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.InkwasmObject(go, sp, 32, r)
		},

		"github.com/inkeliz/go_inkwasm/inkwasm.__free": (sp) => {
			globalThis.inkwasm.Internal.Free(globalThis.inkwasm.Load.Int(go, sp, 8))

		},

		"github.com/inkeliz/go_inkwasm/inkwasm.__call": (sp) => {
			try {
				let r = globalThis.inkwasm.Internal.Call(globalThis.inkwasm.Load.InkwasmObject(go, sp, 8),globalThis.inkwasm.Load.String(go, sp, 24),globalThis.inkwasm.Load.Slice(go, sp, 40, globalThis.inkwasm.Load.ArrayInt32))
				sp = go._inst.exports.getsp() >>> 0
				globalThis.inkwasm.Set.InkwasmObject(go, sp, 64, r)
				globalThis.inkwasm.Set.Bool(go, sp, 80, true)
						}catch(e){
				console.log(e)
				globalThis.inkwasm.Set.Bool(go, sp, 80, false)
			}
		},

		"github.com/inkeliz/go_inkwasm/inkwasm.__callVoid": (sp) => {
			try {
				let r = globalThis.inkwasm.Internal.Call(globalThis.inkwasm.Load.InkwasmObject(go, sp, 8),globalThis.inkwasm.Load.String(go, sp, 24),globalThis.inkwasm.Load.Slice(go, sp, 40, globalThis.inkwasm.Load.ArrayInt32))
				sp = go._inst.exports.getsp() >>> 0
				globalThis.inkwasm.Set.Bool(go, sp, 64, r)
				globalThis.inkwasm.Set.Bool(go, sp, 65, true)
						}catch(e){
				console.log(e)
				globalThis.inkwasm.Set.Bool(go, sp, 65, false)
			}
		},

		"github.com/inkeliz/go_inkwasm/inkwasm.__invoke": (sp) => {
			try {
				let r = globalThis.inkwasm.Internal.Invoke(globalThis.inkwasm.Load.InkwasmObject(go, sp, 8),globalThis.inkwasm.Load.Slice(go, sp, 24, globalThis.inkwasm.Load.ArrayInt32))
				sp = go._inst.exports.getsp() >>> 0
				globalThis.inkwasm.Set.InkwasmObject(go, sp, 48, r)
				globalThis.inkwasm.Set.Bool(go, sp, 64, true)
						}catch(e){
				console.log(e)
				globalThis.inkwasm.Set.Bool(go, sp, 64, false)
			}
		},

		"github.com/inkeliz/go_inkwasm/inkwasm.__invokeVoid": (sp) => {
			try {
				let r = globalThis.inkwasm.Internal.Invoke(globalThis.inkwasm.Load.InkwasmObject(go, sp, 8),globalThis.inkwasm.Load.Slice(go, sp, 24, globalThis.inkwasm.Load.ArrayInt32))
				sp = go._inst.exports.getsp() >>> 0
				globalThis.inkwasm.Set.Bool(go, sp, 48, r)
				globalThis.inkwasm.Set.Bool(go, sp, 49, true)
						}catch(e){
				console.log(e)
				globalThis.inkwasm.Set.Bool(go, sp, 49, false)
			}
		},

		"github.com/inkeliz/go_inkwasm/inkwasm.__newObj": (sp) => {
			try {
				let r = new globalThis.inkwasm.Load.InkwasmObject(go, sp, 8)(globalThis.inkwasm.Load.Slice(go, sp, 24, globalThis.inkwasm.Load.ArrayInt32))
				sp = go._inst.exports.getsp() >>> 0
				globalThis.inkwasm.Set.InkwasmObject(go, sp, 48, r)
				globalThis.inkwasm.Set.Bool(go, sp, 64, true)
						}catch(e){
				console.log(e)
				globalThis.inkwasm.Set.Bool(go, sp, 64, false)
			}
		},

		"github.com/inkeliz/go_inkwasm/inkwasm.__getIndex": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8)[globalThis.inkwasm.Load.Int(go, sp, 24)]
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.InkwasmObject(go, sp, 32, r)
		},

		"github.com/inkeliz/go_inkwasm/inkwasm.__getProp": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8)[globalThis.inkwasm.Load.String(go, sp, 24)]
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.InkwasmObject(go, sp, 40, r)
		},

		"github.com/inkeliz/go_inkwasm/inkwasm.__setProp": (sp) => {
			Reflect.set(globalThis.inkwasm.Load.InkwasmObject(go, sp, 8),globalThis.inkwasm.Load.String(go, sp, 24),globalThis.inkwasm.Load.String(go, sp, 40))

		},

		"github.com/inkeliz/go_inkwasm/inkwasm.__encodeString": (sp) => {
			let r = globalThis.inkwasm.Internal.EncodeString(globalThis.inkwasm.Load.InkwasmObject(go, sp, 8))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.InkwasmObject(go, sp, 24, r)
		},

		"github.com/inkeliz/go_inkwasm/inkwasm.__copyBytes": (sp) => {
			globalThis.inkwasm.Internal.Copy(globalThis.inkwasm.Load.InkwasmObject(go, sp, 8),globalThis.inkwasm.Load.Slice(go, sp, 24, globalThis.inkwasm.Load.ArrayByte))

		},

		"github.com/inkeliz/go_inkwasm/inkwasm.__instanceOf": (sp) => {
			let r = globalThis.inkwasm.Internal.InstanceOf(globalThis.inkwasm.Load.InkwasmObject(go, sp, 8),globalThis.inkwasm.Load.InkwasmObject(go, sp, 24))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.Bool(go, sp, 40, r)
		},

		"github.com/inkeliz/go_inkwasm/inkwasm.__equal": (sp) => {
			let r = globalThis.inkwasm.Internal.Equal(globalThis.inkwasm.Load.InkwasmObject(go, sp, 8),globalThis.inkwasm.Load.InkwasmObject(go, sp, 24))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.Bool(go, sp, 40, r)
		},

		"github.com/inkeliz/go_inkwasm/inkwasm.__strictEqual": (sp) => {
			let r = globalThis.inkwasm.Internal.StrictEqual(globalThis.inkwasm.Load.InkwasmObject(go, sp, 8),globalThis.inkwasm.Load.InkwasmObject(go, sp, 24))
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.Bool(go, sp, 40, r)
		},

	})
})();
(() => {
    let StringEncoder = new TextEncoder();
    let StringDecoder = new TextDecoder();

    let Objects = [];
    let ObjectsUnused = [];

    let ObjectTypes = {
        TypeUndefined: 0,
        TypeNull: 1,
        TypeBoolean: 2,
        TypeNumber: 3,
        TypeBigInt: 4,
        TypeString: 5,
        TypeSymbol: 6,
        TypeFunction: 7,
        TypeObject: 8,
    }

    globalThis.inkwasm = {Load: {}, Set: {}, Internal: {}, Exports: {}}

    globalThis.inkwasm.Exports = {
        MakeSlice: undefined,
        MakeSliceLenArgPtr: undefined,
        MakeSliceResult: undefined,
    }

    globalThis.inkwasm.Internal = {
        parseArgs: function (args) {
            let a = new Array(args.length >> 2);
            for (let i = 0; i < args.length; i += 4) {
                const k = args[i] + (args[i + 1] * 4294967296);
                const v = args[i + 2] + (args[i + 3] * 4294967296);
                a[i >> 2] = Objects[k](go, v, 0);
            }
            return a;
        },
        Invoke: function (o, args) {
            if (args === null || args.length === 0) {
                return o()
            }
            return o(...globalThis.inkwasm.Internal.parseArgs(args))
        },
        Free: function (id) {
            ObjectsUnused.push(id)
        },
        Call: function (o, k, args) {
            if (args === null || args.length === 0) {
                return o[k]()
            }
            return o[k](...globalThis.inkwasm.Internal.parseArgs(args))
        },
        New: function (o, args) {
            if (args.length === 0) {
                return new o()
            }
            return new o(...globalThis.inkwasm.Internal.parseArgs(args))
        },
        Make: function (args) {
            if (args.length === 0) {
                return {}
            }
            return new Object(args)
        },
        Copy: function (o, slice) {
            slice.set(o)
        },
        EncodeString: function (o) {
            return StringEncoder.encode(o);
        },
        InstanceOf: function (o, v) {
            return o instanceof v
        },
        Equal: function (o, v) {
            return o == v
        },
        StrictEqual: function (o, v) {
            return o === v
        }
    }

    globalThis.inkwasm.Load = {
        Float32: function (go, sp, offset) {
            return go.mem.getFloat32(sp + offset, true)
        },
        Float64: function (go, sp, offset) {
            return go.mem.getFloat64(sp + offset, true)
        },

        UintPtr: function (go, sp, offset) {
            return globalThis.inkwasm.Load.Int(go, sp, offset)
        },
        Byte: function (go, sp, offset) {
            return globalThis.inkwasm.Load.Uint8(go, sp, offset)
        },

        Bool: function (go, sp, offset) {
            return globalThis.inkwasm.Load.Uint8(go, sp, offset) !== 0
        },

        Int: function (go, sp, offset) {
            return go.mem.getUint32(sp + offset, true) + go.mem.getInt32(sp + offset + 4, true) * 4294967296;
        },
        Uint: function (go, sp, offset) {
            return go.mem.getUint32(sp + offset, true) + go.mem.getUint32(sp + offset + 4, true) * 4294967296;
        },

        Int8: function (go, sp, offset) {
            return go.mem.getInt8(sp + offset)
        },
        Int16: function (go, sp, offset) {
            return go.mem.getInt16(sp + offset, true)
        },
        Int32: function (go, sp, offset) {
            return go.mem.getInt32(sp + offset, true)
        },
        Int64: function (go, sp, offset) {
            return go.mem.getBigInt64(sp + offset, true)
        },
        Uint8: function (go, sp, offset) {
            return go.mem.getUint8(sp + offset)
        },
        Uint16: function (go, sp, offset) {
            return go.mem.getUint16(sp + offset, true)
        },
        Uint32: function (go, sp, offset) {
            return go.mem.getUint32(sp + offset, true)
        },
        Uint64: function (go, sp, offset) {
            return go.mem.getBigUint64(sp + offset, true)
        },

        String: function (go, sp, offset) {
            return StringDecoder.decode(new DataView(go._inst.exports.mem.buffer, globalThis.inkwasm.Load.UintPtr(go, sp, offset), globalThis.inkwasm.Load.Int(go, sp, offset + 8)));
        },
        Rune: function (go, sp, offset) {
            return globalThis.inkwasm.Load.Uint32(go, sp, offset)
        },

        ArrayFloat32: function (go, sp, offset, len) {
            return new Float32Array(go._inst.exports.mem.buffer, sp + offset, len)
        },
        ArrayFloat64: function (go, sp, offset, len) {
            return new Float64Array(go._inst.exports.mem.buffer, sp + offset, len)
        },

        ArrayUintPtr: function (go, sp, offset, len) {
            return globalThis.inkwasm.Load.ArrayInt64(go, sp, offset, len)
        },

        ArrayByte: function (go, sp, offset, len) {
            return globalThis.inkwasm.Load.ArrayUint8(go, sp, offset, len)
        },
        ArrayInt8: function (go, sp, offset, len) {
            return new Int8Array(go._inst.exports.mem.buffer, sp + offset, len)
        },
        ArrayInt16: function (go, sp, offset, len) {
            return new Int16Array(go._inst.exports.mem.buffer, sp + offset, len)
        },
        ArrayInt32: function (go, sp, offset, len) {
            return new Int32Array(go._inst.exports.mem.buffer, sp + offset, len)
        },
        ArrayInt64: function (go, sp, offset, len) {
            return new BigInt64Array(go._inst.exports.mem.buffer, sp + offset, len)
        },
        ArrayUint8: function (go, sp, offset, len) {
            return new Uint8Array(go._inst.exports.mem.buffer, sp + offset, len)
        },
        ArrayUint16: function (go, sp, offset, len) {
            return new Uint16Array(go._inst.exports.mem.buffer, sp + offset, len)
        },
        ArrayUint32: function (go, sp, offset, len) {
            return new Uint32Array(go._inst.exports.mem.buffer, sp + offset, len)
        },
        ArrayUint64: function (go, sp, offset, len) {
            return new BigUint64Array(go._inst.exports.mem.buffer, sp + offset, len)
        },
        ArrayRune: function (go, sp, offset, len) {
            return globalThis.inkwasm.Load.ArrayUint32(go, sp, offset, len)
        },


        Array: function (go, sp, offset, len, f) {
            return f(go, sp, offset, len).slice(0, len)
        },
        Slice: function (go, sp, offset, f) {
            let ptr = globalThis.inkwasm.Load.UintPtr(go, sp, offset)
            let len = globalThis.inkwasm.Load.Int(go, sp, offset + 8)
            if (len === 0) {
                return null
            }
            return f(go, ptr, 0, len)
        },
        Ptr: function (go, sp, offset, f) {
            return f(go, globalThis.inkwasm.Load.UintPtr(go, sp, offset), 0)
        },
        SliceOf: function (f) {
            return function (go, sp, offset) {
                return f(go, globalThis.inkwasm.Load.UintPtr(go, sp, offset), 0, globalThis.inkwasm.Load.Int(go, sp, offset + 8))
            }
        },
        BigInt: function (go, sp, offset) {
            const neg = globalThis.inkwasm.Load.Bool(go, sp, offset)
            const abs = globalThis.inkwasm.Load.Slice(go, sp, offset + 8, globalThis.inkwasm.Load.ArrayUint64)

            let length = BigInt(abs.length) - 1n
            let result = BigInt(0)
            for (let i = BigInt(0); i <= length; i++) {
                result += BigInt(abs[i]) * (2n << (((i) * 64n) - 1n))
            }
            if (neg) {
                return -result
            }
            return result
        },
        UnsafePointer: function (go, sp, offset) {
            return globalThis.inkwasm.Load.Int(go, sp, offset)
        },
        InkwasmObject: function (go, sp, offset) {
            switch (globalThis.inkwasm.Load.Uint8(go, sp, offset + 8)) {
                case ObjectTypes.TypeUndefined:
                    return undefined
                case ObjectTypes.TypeNull:
                    return null
                case ObjectTypes.TypeBoolean:
                    return globalThis.inkwasm.Load.Uint8(go, sp, offset) !== 0
                case ObjectTypes.TypeNumber:
                    return globalThis.inkwasm.Load.Int(go, sp, offset)
                default:
                    return Objects[globalThis.inkwasm.Load.Int(go, sp, offset)]
            }
        }
    }

    globalThis.inkwasm.Set = {
        Float32: function (go, sp, offset, v) {
            go.mem.setFloat32(sp + offset, v, true)
        },
        Float64: function (go, sp, offset, v) {
            go.mem.setFloat64(sp + offset, v, true)
        },

        UintPtr: function (go, sp, offset, v) {
            globalThis.inkwasm.Set.Int(go, sp, offset, v, true)
        },
        Byte: function (go, sp, offset, v) {
            globalThis.inkwasm.Set.Uint8(go, sp, offset, v, true)
        },

        Bool: function (go, sp, offset, v) {
            globalThis.inkwasm.Set.Uint8(go, sp, offset, v === true, true)
        },

        Int: function (go, sp, offset, v) {
            go.mem.setUint32(sp + offset, v, true)
            go.mem.setInt32(sp + offset + 4, v * 4294967296, true);
        },
        Uint: function (go, sp, offset, v) {
            go.mem.setUint32(sp + offset, v, true)
            go.mem.setInt32(sp + offset + 4, v * 4294967296, true);
        },

        Int8: function (go, sp, offset, v) {
            go.mem.setInt8(sp + offset, v)
        },
        Int16: function (go, sp, offset, v) {
            go.mem.setInt16(sp + offset, v, true)
        },
        Int32: function (go, sp, offset, v) {
            go.mem.setInt32(sp + offset, v, true)
        },
        Int64: function (go, sp, offset, v) {
            go.mem.setBigInt64(sp + offset, v, true)
        },
        Uint8: function (go, sp, offset, v) {
            go.mem.setUint8(sp + offset, v)
        },
        Uint16: function (go, sp, offset, v) {
            go.mem.setUint16(sp + offset, v, true)
        },
        Uint32: function (go, sp, offset, v) {
            go.mem.setUint32(sp + offset, v, true)
        },
        Uint64: function (go, sp, offset, v) {
            go.mem.setBigUint64(sp + offset, v, true)
        },

        /*
        String: function (go, sp, offset, v) {
            let ptr = 0;
            let len = 0;
            if (typeof StringEncoder.encodeInto === "undefined") {
                let s = StringEncoder.encode(v);
                len = s.length
                ptr = globalThis.inkwasm.Internal.MakeSlice(v.length)
                new Uint8Array(this._inst.exports.mem.buffer, ptr, len).set(s)
            } else {
                ptr = globalThis.inkwasm.Internal.MakeSlice(v.length * 3)
                let r = StringEncoder.encodeInto(v, new Uint8Array(go._inst.exports.mem.buffer, ptr, v.length * 3));
                len = r.read;
            }

            sp = go._inst.exports.getsp() >>> 0;
            globalThis.inkwasm.Set.UintPtr(go, sp, offset, ptr)
            globalThis.inkwasm.Set.Int(go, sp, offset + 8, len)
        },
         */

        String: function (go, sp, offset, v) {
            globalThis.inkwasm.Set.InkwasmObject(go, sp, offset, StringEncoder.encode(v))
        },

        Rune: function (go, sp, offset, v) {
            globalThis.inkwasm.Set.Uint32(go, sp, offset, v)
        },

        Slice: function (go, sp, offset, v, m) {
            globalThis.inkwasm.Set.InkwasmObject(go, sp, offset, v)
        },

        Array: function (go, sp, offset, v, len, m, f) {
            if (v.length < len) {
                len = v.length
            }
            if (len === 0) {
                return
            }
            for (let i = 0; i < len; i++) {
                f(go, sp, offset, v[i])
                offset += m
            }
        },

        /*
        Slice: function (go, sp, offset, v, m) {
            let len = 0
            if (typeof v.byteLength !== "undefined") {
                len = v.byteLength
            }
            if (v instanceof ArrayBuffer) {
                v = new Uint8Array(v, 0, v.byteLength)
            }
            let ptr = globalThis.inkwasm.Internal.MakeSlice(len)
            new Uint8Array(go._inst.exports.mem.buffer, ptr, len).set(v)

            sp = go._inst.exports.getsp() >>> 0
            globalThis.inkwasm.Set.UintPtr(go, sp, offset, ptr)
            globalThis.inkwasm.Set.Int(go, sp, offset + 8, v.byteLength / m)
            globalThis.inkwasm.Set.Int(go, sp, offset + 16, v.byteLength / m)
        },
         */

        UnsafePointer: function (go, sp, offset, v) {
            globalThis.inkwasm.Set.Int(go, sp, offset, v)
        },

        Object: function (go, sp, offset, v) {
            let o = ObjectsUnused.pop()
            if (typeof o === "undefined") {
                o = Objects.push(v) - 1
            } else {
                Objects[o] = v
            }
            globalThis.inkwasm.Set.Int(go, sp, offset, o)
        },
        InkwasmObject: function (go, sp, offset, v) {
            switch (typeof v) {
                case "undefined":
                    globalThis.inkwasm.Set.Uint8(go, sp, offset + 8, ObjectTypes.TypeUndefined)
                    break;
                case "object":
                    if (v === null) {
                        globalThis.inkwasm.Set.Uint8(go, sp, offset + 8, ObjectTypes.TypeNull);
                    } else {
                        globalThis.inkwasm.Set.Object(go, sp, offset, v);
                        globalThis.inkwasm.Set.Uint8(go, sp, offset + 8, ObjectTypes.TypeObject);
                        if (Array.isArray(v) || v.length !== undefined || v.byteLength !== undefined) {
                            let len = v.length
                            if (v.byteLength !== undefined) {
                                len = v.byteLength
                            }
                            globalThis.inkwasm.Set.Uint32(go, sp, offset + 12, len);
                        }
                    }
                    break;
                case "boolean":
                    globalThis.inkwasm.Set.Bool(go, sp, offset + 8, v);
                    globalThis.inkwasm.Set.Uint8(go, sp, offset + 8, ObjectTypes.TypeBoolean);
                    break;
                case "number":
                    globalThis.inkwasm.Set.Float64(go, sp, offset + 8, v);
                    globalThis.inkwasm.Set.Uint8(go, sp, offset + 8, ObjectTypes.TypeNumber);
                    break;
                case "bigint":
                    globalThis.inkwasm.Set.Object(go, sp, offset, v);
                    globalThis.inkwasm.Set.Uint8(go, sp, offset + 8, ObjectTypes.TypeBigInt);
                    break;
                case "string":
                    globalThis.inkwasm.Set.Object(go, sp, offset, v);
                    globalThis.inkwasm.Set.Uint8(go, sp, offset + 8, ObjectTypes.TypeString);
                    globalThis.inkwasm.Set.Uint32(go, sp, offset + 12, v.length);
                    break;
                case "symbol":
                    globalThis.inkwasm.Set.Object(go, sp, offset, v);
                    globalThis.inkwasm.Set.Uint8(go, sp, offset + 8, ObjectTypes.TypeSymbol);
                    break;
                case "function":
                    globalThis.inkwasm.Set.Object(go, sp, offset, v);
                    globalThis.inkwasm.Set.Uint8(go, sp, offset + 8, ObjectTypes.TypeFunction);
                    break;
            }
        }
    }

})();// Code generated by INKWASM BUILD; DO NOT EDIT
(() => {

})();
// Code generated by INKWASM BUILD; DO NOT EDIT
(() => {
	Object.assign(go.importObject.go, {

		"gioui.org/app.__isContextLost": (sp) => {
			let r = globalThis.inkwasm.Load.InkwasmObject(go, sp, 8).isContextLost()
			sp = go._inst.exports.getsp() >>> 0
			globalThis.inkwasm.Set.Bool(go, sp, 24, r)
		},

	})
})();
(() => {
	defaultGo = new Go();
	Object.assign(defaultGo["argv"], defaultGo["argv"].concat(go["argv"]));
	Object.assign(defaultGo["env"], go["env"]);
	for (let key in go["importObject"]) {
		if (typeof defaultGo["importObject"][key] === "undefined") {
			defaultGo["importObject"][key] = {};
		}
		Object.assign(defaultGo["importObject"][key], go["importObject"][key]);
	}
	window.go = defaultGo;
    if (!WebAssembly.instantiateStreaming) { // polyfill
        WebAssembly.instantiateStreaming = async (resp, importObject) => {
            const source = await (await resp).arrayBuffer();
            return await WebAssembly.instantiate(source, importObject);
        };
    }
    WebAssembly.instantiateStreaming(fetch("main.wasm"), go.importObject).then((result) => {
        go.run(result.instance);
    });
})();