import test from 'node:test';
import { run_entity_provider_conformance_tests } from '../dist/XEntityManager/EntityProviderConformanceTests.js';

test('existing xdb, memory, SQLite conformance and Mongo normalization regressions', { timeout: 60000 }, async () => {
  await run_entity_provider_conformance_tests();
});
