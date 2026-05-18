/**
 * Warmup: valida o provider de embeddings configurado.
 *
 * Para Voyage: faz uma chamada de teste à API, valida key e dim.
 * Para Local (Transformers.js): força o download do modelo Xenova/all-MiniLM-L6-v2.
 *
 * Provider escolhido por env (em ordem):
 *   1. CAPITU_EMBEDDINGS=voyage|local
 *   2. VOYAGE_API_KEY presente -> voyage
 *   3. fallback                -> local
 *
 * Uso:
 *   npm run warmup:embeddings
 */

import { resolveEmbeddingsProvider } from '@capitu/kb';

async function main(): Promise<void> {
  const provider = resolveEmbeddingsProvider();
  console.log('=== capitu warmup: embeddings ===\n');
  console.log(`Provider : ${provider.constructor.name}`);
  console.log(`Model    : ${provider.model}`);
  console.log(`Dim      : ${provider.dim}\n`);

  console.log('-> Gerando embedding de teste...');
  const t0 = Date.now();
  try {
    const [vec] = await provider.embed(['Hello capitu, this is a warmup probe.']);
    const elapsed = Date.now() - t0;
    if (!vec) {
      console.error('\n[FAIL] provider retornou vetor vazio.');
      process.exit(1);
    }
    if (vec.length !== provider.dim) {
      console.error(
        `\n[FAIL] mismatch de dimensoes: vec.length=${vec.length} vs provider.dim=${provider.dim}`,
      );
      process.exit(2);
    }
    console.log(`[OK] embedding gerado em ${elapsed}ms`);
    console.log(`     vec.length = ${vec.length}`);
    console.log(
      `     primeiros 5 valores = [${vec.slice(0, 5).map((v) => v.toFixed(4)).join(', ')}]`,
    );
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    console.log(`     norma L2 = ${norm.toFixed(4)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('\n[FAIL] erro ao gerar embedding:');
    console.error(`  ${msg}`);
    console.error('\nProvider em uso:', provider.constructor.name);
    if (provider.constructor.name === 'VoyageEmbeddings') {
      console.error('\nPossiveis causas:');
      console.error('  - VOYAGE_API_KEY invalida ou nao setada');
      console.error('  - api.voyageai.com inacessivel da sua rede');
      console.error('  - Free tier excedido (raro, sao 200M tokens)');
    } else {
      console.error('\nPossiveis causas:');
      console.error('  - huggingface.co bloqueado na rede');
      console.error('  - Sem internet ou proxy nao configurado');
      console.error('\nFix: usar Voyage em vez de local. Crie key em voyageai.com,');
      console.error('     setar VOYAGE_API_KEY persistente:');
      console.error('     [Environment]::SetEnvironmentVariable("VOYAGE_API_KEY", "<key>", "User")');
    }
    process.exit(3);
  }

  console.log('\n-> Segunda chamada (cache hit / connection reuse):');
  const t1 = Date.now();
  await provider.embed(['Outra string qualquer.']);
  console.log(`[OK] segunda chamada: ${Date.now() - t1}ms`);

  console.log('\n=== warmup OK ===\n');
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
