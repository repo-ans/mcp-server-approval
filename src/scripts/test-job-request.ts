// Runs the job request workflow on a sample email (.txt) or PDF.
//   npm run test-job-request                                   # samples/job-request-email.txt
//   npm run test-job-request -- samples/job-request.pdf
//   npm run test-job-request -- samples/job-request.pdf --dry-run   # extract only, no Slack approval
// The approval is posted to Slack; keep `npm run dev` (and the tunnel) running so the Approve click is handled.
import { readFileSync } from 'node:fs';
import '../registry.js';
import { extractJobRequest, submitJobRequest, type JobRequestInput } from '../workflows/job-request.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const file = args.find((a) => !a.startsWith('--')) ?? 'samples/job-request-email.txt';

const input: JobRequestInput = file.toLowerCase().endsWith('.pdf')
  ? { pdfBase64: readFileSync(file).toString('base64') }
  : { text: readFileSync(file, 'utf8') };

console.log(`Processing ${file} (${'pdfBase64' in input ? 'PDF' : 'text'})${dryRun ? ' [dry run]' : ''}...\n`);
const started = Date.now();

try {
  if (dryRun) {
    console.log(JSON.stringify(await extractJobRequest(input), null, 2));
  } else {
    const result = await submitJobRequest('cli-test', input);
    console.log('Extracted:\n' + JSON.stringify(result.extracted, null, 2));
    console.log(result.existing_customer ? `\nExisting customer matched: ${result.existing_customer.name} (${result.existing_customer.id})` : '\nNo existing customer matched: approval will create one.');
    console.log(`\nPending approval in Slack (request id ${result.approval_request_id}).`);
  }
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
} catch (err) {
  console.error('Failed:', (err as Error).message);
  process.exit(1);
}
