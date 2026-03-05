/**
 * Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// If the loader is already loaded, just stop.
if (!self.define) {
  let registry = {};

  // Used for `eval` and `importScripts` where we can't get script URL by other means.
  // In both cases, it's safe to use a global var because those functions are synchronous.
  let nextDefineUri;

  const singleRequire = (uri, parentUri) => {
    uri = new URL(uri + ".js", parentUri).href;
    return registry[uri] || (
      
        new Promise(resolve => {
          if ("document" in self) {
            const script = document.createElement("script");
            script.src = uri;
            script.onload = resolve;
            document.head.appendChild(script);
          } else {
            nextDefineUri = uri;
            importScripts(uri);
            resolve();
          }
        })
      
      .then(() => {
        let promise = registry[uri];
        if (!promise) {
          throw new Error(`Module ${uri} didn’t register its module`);
        }
        return promise;
      })
    );
  };

  self.define = (depsNames, factory) => {
    const uri = nextDefineUri || ("document" in self ? document.currentScript.src : "") || location.href;
    if (registry[uri]) {
      // Module is already loading or loaded.
      return;
    }
    let exports = {};
    const require = depUri => singleRequire(depUri, uri);
    const specialDeps = {
      module: { uri },
      exports,
      require
    };
    registry[uri] = Promise.all(depsNames.map(
      depName => specialDeps[depName] || require(depName)
    )).then(deps => {
      factory(...deps);
      return exports;
    });
  };
}
define(['./workbox-5a5d9309'], (function (workbox) { 'use strict';

  self.skipWaiting();
  workbox.clientsClaim();

  /**
   * The precacheAndRoute() method efficiently caches and responds to
   * requests for URLs in the manifest.
   * See https://goo.gl/S9QRab
   */
  workbox.precacheAndRoute([{
    "url": "registerSW.js",
    "revision": "1872c500de691dce40960bb85481de07"
  }, {
    "url": "pwa-512x512.png",
    "revision": "d6e324ee58ee1fba835984b669cf188b"
  }, {
    "url": "pwa-192x192.png",
    "revision": "12579a898b09d26929629617fcedbe7e"
  }, {
    "url": "index.html",
    "revision": "0d7693a739b59a488bd5ce1f975d85bb"
  }, {
    "url": "favicon.svg",
    "revision": "035b9a637a033f48c6b0346cce947112"
  }, {
    "url": "assets/xlsx-CNerDvZX.js",
    "revision": null
  }, {
    "url": "assets/index-hWBVPwmB.js",
    "revision": null
  }, {
    "url": "assets/index-Cs5oz2oJ.js",
    "revision": null
  }, {
    "url": "assets/index-CIqi1jFK.js",
    "revision": null
  }, {
    "url": "assets/index-BIZxHRqT.css",
    "revision": null
  }, {
    "url": "assets/index-36k2IRl8.js",
    "revision": null
  }, {
    "url": "assets/ics-parser-CVTPRwgH.js",
    "revision": null
  }, {
    "url": "assets/automerge_wasm_bg-BQ4CNPIj.wasm",
    "revision": null
  }, {
    "url": "favicon.svg",
    "revision": "035b9a637a033f48c6b0346cce947112"
  }, {
    "url": "pwa-192x192.png",
    "revision": "12579a898b09d26929629617fcedbe7e"
  }, {
    "url": "pwa-512x512.png",
    "revision": "d6e324ee58ee1fba835984b669cf188b"
  }, {
    "url": "manifest.webmanifest",
    "revision": "98acd988ac79ca9e5724110925f7e5a8"
  }], {});
  workbox.cleanupOutdatedCaches();
  workbox.registerRoute(new workbox.NavigationRoute(workbox.createHandlerBoundToURL("index.html"), {
    denylist: [/^\/api\//, /^\/health/, /^\/dav\//, /^\/automerge\//, /^\/docs\//]
  }));

}));
//# sourceMappingURL=sw.js.map
