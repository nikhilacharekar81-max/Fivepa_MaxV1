import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

console.log('Running WorkPerHour Financial & Security Audit Test Suite (Isolated Serial Mode)...');

const testDir = path.resolve('tests');
const testFiles = fs.readdirSync(testDir)
  .filter(file => file.endsWith('.test.ts'))
  .map(file => path.join('tests', file))
  .sort();

async function runTestsSequentially() {
  for (const file of testFiles) {
    console.log(`\n========================================`);
    console.log(`Running test file: ${file}`);
    console.log(`========================================\n`);
    
    await new Promise((resolve) => {
      const child = spawn('npx', ['tsx', '--test', file], {
        stdio: 'inherit',
        shell: true,
        env: { ...process.env, NODE_ENV: 'test', ALLOW_MOCK_CODES: 'true' }
      });
      child.on('close', (code) => {
        if (code !== 0) {
          console.error(`\n[FAIL] Test file ${file} failed with exit code ${code}`);
          process.exit(code || 1);
        }
        resolve(null);
      });
    });
  }
  console.log('\n========================================');
  console.log('ALL TEST FILES PASSED SUCCESSFULLY!');
  console.log('========================================\n');
  process.exit(0);
}

runTestsSequentially().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
