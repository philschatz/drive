// Raise the browser main thread's log level from the persisted debug-enable
// setting, BEFORE anything has a chance to log.
//
// Import this as the FIRST relative import in main.tsx: worker-api.ts logs at
// module scope, and ES imports evaluate in source order, so a later position
// would let that first line escape at the default level. It is a side-effecting
// module for exactly that reason — there is nothing to call.
//
// The engine (worker / CLI / CalDAV) does the same thing for itself in
// DriveEngine.init(), reading the flag through host.kv — src/shared must not
// import this file's idb-storage dependency (tests/layering.test.ts). Each
// thread is its own module graph, so each configures its own logger.
//
// No Settings-UI wiring is needed: setDebugEnabled() reloads the page, so the
// new value is picked up on the next boot.
import { settingGetSync } from '../shared/idb-storage';
import { setLogLevel } from '../../shared/logger';

if (settingGetSync('debug-enable')) setLogLevel('debug');
