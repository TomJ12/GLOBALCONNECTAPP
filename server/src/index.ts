/**
 * Entry point. Checks the Node.js version FIRST, with a plain message, and
 * only then loads the server: the server imports Node's built-in SQLite
 * module, and on an older Node that import fails with an error nobody could
 * be expected to understand.
 */
import { nodeVersionProblem } from './nodeVersion';

const problem = nodeVersionProblem();
if (problem) {
  console.error(problem);
  process.exit(1);
}
await import('./main');
