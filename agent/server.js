// Entry file for hosts that start a Node app by running a file directly
// (Hostinger's Express preset defaults to `server.js`). The TypeScript
// source is compiled into dist/ by the `postinstall` script, so a plain
// `npm install` is all the host needs to run before starting this.
import './dist/index.js';
