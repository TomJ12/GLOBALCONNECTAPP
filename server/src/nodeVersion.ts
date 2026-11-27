/** The oldest Node.js the server runs on: `node:sqlite` without a flag, with the options used here. No imports, so it can run before anything else loads. */
export const MINIMUM_NODE = '22.13.0';

export function nodeVersionProblem(version: string = process.versions.node): string | null {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  const [needMajor = 0, needMinor = 0] = MINIMUM_NODE.split('.').map(Number);
  if (major > needMajor || (major === needMajor && minor >= needMinor)) return null;
  return `Node.js ${MINIMUM_NODE} or newer is required (this is ${version}).\nThe server keeps its data with Node's built-in SQLite module, which older versions do not have.\nInstall a current Node 22, for example:  nvm install 22 && nvm use 22`;
}
