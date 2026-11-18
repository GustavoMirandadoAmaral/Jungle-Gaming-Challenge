import { spawnSync } from 'node:child_process';

const requestedFiles = process.argv.slice(2);
const requestedSet = new Set(requestedFiles.map((file) => file.replaceAll('\\', '/')));
const testFiles = [...new Bun.Glob('src/**/*.integration.spec.ts').scanSync()]
  .filter((testFile) => requestedSet.size === 0 || requestedSet.has(testFile.replaceAll('\\', '/')))
  .sort();
const failures: string[] = [];

if (testFiles.length === 0) {
  console.error('Nenhum arquivo de integração foi encontrado para executar.');
  process.exit(1);
}

for (const testFile of testFiles) {
  console.log(`\n=== Integração: ${testFile} ===`);
  const result = spawnSync(process.execPath, ['test', testFile], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`Não foi possível executar ${testFile}: ${result.error.message}`);
    failures.push(testFile);
  } else if (result.status !== 0) {
    failures.push(testFile);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} arquivo(s) de integração falharam: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`\nTodos os ${testFiles.length} arquivos de integração passaram.`);
}
