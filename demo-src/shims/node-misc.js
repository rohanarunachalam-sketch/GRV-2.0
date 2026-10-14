// Tiny stand-ins for node:fs / node:path / node:url (the browser has no files; the demo keeps its data in localStorage).
export const sep = '/';
export const join = (...p) => p.join('/').replace(/\/+/g, '/');
export const existsSync = () => false;
export const mkdirSync = () => {};
export const writeFileSync = () => {};
export const readFileSync = () => { throw new Error('no file system in the browser'); };
export const pathToFileURL = (p) => ({ href: 'file://' + p });
