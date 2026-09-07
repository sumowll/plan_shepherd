import { writeFile } from 'node:fs/promises';
import { STATES } from '../src/catalog/schema';
import { PLAN_FAMILIES } from '../src/shared/contracts';
const path = process.argv[2];
if (!path) throw new Error('Usage: npm run readiness:template -- /path/to/readiness.json');
const record = { reviewedAt: '', reviewer: '', catalogReleaseId: '', liveAtriusImportVerified: false, liveCignaEmployerImportVerified: false, aiRetentionVerified: false, cloudflareServiceScopeVerified: false, callbackRetentionReviewed: false, independentCalculationReviewPassed: false, loadTestPassed: false, incidentAndRollbackRunbookReviewed: false, coverage: STATES.flatMap(state => PLAN_FAMILIES.map(family => ({ state, family, status: 'source_gap', evidence: '' }))) };
await writeFile(path, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
process.stdout.write('Created an unapproved release template. Replace placeholders only after actual verification.\n');
