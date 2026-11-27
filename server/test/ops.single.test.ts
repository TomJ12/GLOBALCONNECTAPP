/**
 * The ops console's test file, run again in SINGLE-PERSON mode (the default mode of the product): every action is
 * carried out by the one member of staff who starts it. See the note at the top of ops.test.ts.
 */
process.env.OPS_TEST_MODE = 'single';
await import('./ops.test');
export {};
