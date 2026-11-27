// https://docs.expo.dev/guides/customizing-metro/
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// When the app is built to talk to the Global Connect server, the in-app demo
// backend (and with it the provider-shaped client, mapping and mock) is left
// out of the bundle altogether: the import resolves to an empty module.
const usesServer = Boolean(process.env.EXPO_PUBLIC_API_URL);
const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (usesServer && /(^|\/)adapters\/demoBackend$/.test(moduleName)) return { type: 'empty' };
  return (defaultResolve ?? context.resolveRequest)(context, moduleName, platform);
};

// The server is a separate Node package; Metro has no business watching it.
config.resolver.blockList = [/\/server\/node_modules\/.*/, /\/dist-demo\/.*/];

module.exports = config;
