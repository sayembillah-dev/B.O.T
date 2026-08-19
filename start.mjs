// 🪟 cross-platform prod launcher — "npm start" used to be
//    `NODE_ENV=production node server.js`, which only parses on POSIX shells
//    (Windows cmd/PowerShell choke on the inline env). Set it in-process instead.
process.env.NODE_ENV = 'production';
await import('./server.js');
