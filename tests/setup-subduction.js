// automerge-repo (subduction.37) builds Subduction internally and no longer
// exposes setSubductionModule(). The Subduction WASM is initialized as a side
// effect of importing the non-`/slim` entry of @automerge/automerge-subduction
// (which the jest moduleNameMapper points at the node CJS build). The `/slim`
// entry the Repo uses internally shares that same module-scoped WASM instance,
// so requiring it here is enough to make `new Repo(...)` work under jest.
require('@automerge/automerge-subduction');
