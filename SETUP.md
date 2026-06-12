# Setup — capitu-mcp

Você tem **2 caminhos**: o instalador automático (recomendado) ou setup manual.

## ✨ Caminho rápido: instalador

```powershell
git clone https://github.com/icaroavb/capitu-mcp.git
cd capitu-mcp
.\install.ps1
```

O instalador faz 8 passos interativos:

1. Verifica Node ≥ 18 instalado
2. Pergunta URL/usuário/mandant/idioma do SAP
3. Pede a senha (oculta — não fica em arquivo)
4. Pergunta sobre embeddings (bm25 padrão; voyage ou local opcionais)
5. Pergunta se quer habilitar escrita ABAP
6. Gera `.mcp.json` a partir do template
7. Roda `npm install`
8. Smoke test opcional contra o SAP

Ao final, abra um **PowerShell novo** (para herdar as env vars salvas) e rode:

```powershell
claude
```

No Claude Code, `/mcp` deve listar os 3 servidores capitu como conectados.

## Pré-requisitos do sistema

| Ferramenta | Versão mínima | Como obter |
|------------|---------------|------------|
| Node.js | 22 LTS | `winget install OpenJS.NodeJS.LTS` |
| Claude Code CLI | 2.x | [code.claude.com](https://code.claude.com) ou via Claude Desktop |
| SAP com ADT habilitado | qualquer S/4HANA moderno | tenant onde você tem permissão de dev |
| Eclipse com ADT (opcional) | mais recente | [tools.hana.ondemand.com](https://tools.hana.ondemand.com) |

> ⚠️ **Rede:** Voyage AI e HuggingFace podem estar bloqueados em redes corporativas. O modo `bm25` (padrão) funciona em qualquer rede.

## Modo manual (sem o instalador)

Se preferir não rodar o `.ps1` (auditoria de segurança, sistema não-Windows, etc.):

### 1. Instale dependências

```powershell
npm install
```

### 2. Salve a senha SAP como variável persistente

```powershell
$secure = Read-Host -AsSecureString "Senha SAP"
$plain = [System.Net.NetworkCredential]::new("", $secure).Password
[Environment]::SetEnvironmentVariable("SAP_PASSWORD", $plain, "User")
$plain = $null; Remove-Variable secure
```

### 3. (Opcional) Salve VOYAGE_API_KEY

Mesma técnica, se quiser usar Voyage embeddings.

### 4. Crie o `.mcp.json` do template

```powershell
Copy-Item .mcp.example.json .mcp.json
```

Edite `.mcp.json` substituindo todos os `<PLACEHOLDERS>` pelos seus valores.

### 5. Abra o Claude Code

```powershell
claude
```

Aprove os 3 servidores quando solicitado.

## Troubleshooting

| Problema | Causa provável | Fix |
|----------|---------------|-----|
| `Server disconnected` + `NODE_MODULE_VERSION` no log | better-sqlite3 compilado para outro Node | Veja **"better-sqlite3 / NODE_MODULE_VERSION"** abaixo |
| `No SAP instances configured` (mas você setou as env vars!) | Cliente MCP lança o servidor com ambiente sanitizado | Veja **"Env vars não chegam ao servidor"** abaixo |
| `Server disconnected` | Variável de ambiente faltando | Veja `[Environment]::GetEnvironmentVariable("SAP_PASSWORD", "User").Length` |
| `401 Unauthorized` | Senha errada ou conta bloqueada | Teste no SAP GUI primeiro |
| `403 stateful session required` | Bug raro do MCP | Reabra Claude Code |
| `master description in original language` | `SAP_LANGUAGE` errado | Confirme idioma original do sistema (PT, EN, DE...) |
| `corrNr could not be found` | Pacote exige transport | Use `capituDevListTransports` para escolher uma TR aberta |
| Tools não aparecem em `/mcp` | Claude Code carregou config antiga | Feche e abra novamente o Claude Code |

### better-sqlite3 / NODE_MODULE_VERSION

Se o log do servidor mostra algo como:

```
The module '...better_sqlite3.node' was compiled against a different Node.js
version using NODE_MODULE_VERSION 108. This version of Node.js requires
NODE_MODULE_VERSION 137.
```

**Causa:** capitu usa `better-sqlite3`, um módulo **nativo** compilado para uma
versão específica do Node (o "ABI", ou `NODE_MODULE_VERSION`). Se você tem mais
de um Node na máquina — tipicamente um Node do **nvm** + o Node global em
`C:\Program Files\nodejs` — o `npm install` pode ter compilado o módulo para um
ABI, enquanto o Claude lança os servidores com **outro** Node. Aí o binário não
carrega e os 3 servidores caem no boot.

| ABI (`NODE_MODULE_VERSION`) | Versão do Node |
|---|---|
| 108 | Node 18 |
| 115 | Node 20 |
| 127 | Node 22 |
| 137 | Node 24 |

**Fix:** reinstale/rebuilde o módulo nativo com o **mesmo Node que o Claude usa**
(quase sempre o de `C:\Program Files\nodejs`). Em um PowerShell:

```powershell
cd <caminho-do-capitu-mcp>
$env:Path = "C:\Program Files\nodejs;$env:Path"   # põe o Node do Claude na frente
node --version                                     # confirme qual Node está ativo
npm run rebuild:native                             # baixa o binário pré-compilado p/ esse ABI
node -e "require('better-sqlite3')"                # silêncio = OK
```

Depois reabra o Claude e rode `/mcp` — os 3 servidores devem conectar.

> 💡 **Por que acontece de novo:** se você rodar `npm install` de um shell cujo
> Node padrão é diferente (ex.: um terminal onde o `nvm` deixou o Node 18 como
> default), o módulo é recompilado para o ABI errado e o problema volta. Rode
> sempre o install com o Node de `Program Files` na frente do PATH. O capitu já
> tem um `postinstall` (`npm run check:native`) que **detecta** esse descasamento
> e te diz exatamente o que fazer.

### Env vars não chegam ao servidor (Claude Desktop)

Sintoma: você salvou `SAP_URL`/`SAP_PASSWORD` como variáveis persistentes do
Windows, elas aparecem no PowerShell, **mas o servidor reclama** com
`No SAP instances configured` ou `SAP_URL is missing`.

**Causa:** alguns clientes MCP — o **Claude Desktop** em particular — lançam os
servidores stdio com um ambiente **sanitizado**: um PATH próprio + somente o que
estiver no bloco `env` da config do servidor. As variáveis User do Windows
existem no registro, mas **não são repassadas** ao processo.

**Como o capitu lida:** no Windows, quando uma variável esperada não está no
ambiente do processo, o capitu lê o **User scope diretamente do registro**
(`HKCU\Environment`) — exatamente onde o `install.ps1`/`SETUP.md` mandam salvar.
Ou seja: salvou como variável persistente User → funciona em qualquer cliente,
sem pôr senha em arquivo nenhum.

Isso vale para: `SAP_URL`, `SAP_USER`, `SAP_CLIENT`, `SAP_LANGUAGE`,
`CAPITU_INSTANCES_PATH`, `CAPITU_KB_PATH`, `CAPITU_COMPLIANCE_MODE`,
`CAPITU_I_UNDERSTAND_API_POLICY_RISK`, `CAPITU_EMBEDDINGS`, `VOYAGE_API_KEY`,
`CAPITU_ALLOW_WRITES`, `CAPITU_ALLOWED_PACKAGES`, a senha de cada perfil
(`passwordEnv`) e o token bearer (`bearerEnv`).

> No Claude Code (CLI) isso raramente é necessário — o `.mcp.json` tem um bloco
> `env` que é repassado. Mas o fallback cobre os dois mundos: salvar como
> variável persistente User funciona tanto no CLI quanto no Desktop, sem
> precisar manter dois arquivos de config sincronizados manualmente.

## Habilitando escrita ABAP

Duas formas — escolha conforme o cliente que você usa:

**Só Claude Code (CLI):** edite `.mcp.json`, no servidor `capitu-dev`:

- `CAPITU_ALLOW_WRITES`: `"true"`
- `CAPITU_ALLOWED_PACKAGES`: `"$TMP,<seu-pacote>"` (CSV, suporta wildcard `Z*`)

Reinicie o Claude Code para aplicar.

**Claude Code + Claude Desktop (ou só Desktop):** o `claude_desktop_config.json`
não tem bloco `env` por servidor, então edite `.mcp.json` **não ajuda** o
Desktop. Salve as mesmas duas chaves como variáveis persistentes do Windows
User (mesmo mecanismo da seção anterior) — assim os dois clientes leem o mesmo
valor:

```powershell
[Environment]::SetEnvironmentVariable("CAPITU_ALLOW_WRITES", "true", "User")
[Environment]::SetEnvironmentVariable("CAPITU_ALLOWED_PACKAGES", "$TMP,<seu-pacote>", "User")
```

Reinicie o Claude Code e o Claude Desktop para aplicar. Se `.mcp.json` também
definir essas chaves, ele tem prioridade só no CLI (o bloco `env` do
`.mcp.json` é repassado direto, sem passar pelo registro) — para evitar
divergência entre os dois clientes, prefira manter `.mcp.json` sem essas duas
chaves e usar só a env var User.

> ⚠️ Mantenha `$TMP` como único pacote permitido até estar confiante. Erro em um prompt pode criar/alterar objetos no SAP.

## Configurar várias instâncias (consultor)

Para alternar entre sistemas SAP sem reabrir o Claude Code:

1. Copie [`instances.example.json`](instances.example.json) para `~/.capitu/instances.json` e edite os perfis (cada um com `name`, `url`, `user`, `client`, `language`, `passwordEnv`).
2. Para cada instância, salve a senha na env var nomeada em `passwordEnv` (escopo User):
   ```powershell
   $secure = Read-Host -AsSecureString "Senha do cliente X"
   $plain = [System.Net.NetworkCredential]::new("", $secure).Password
   [Environment]::SetEnvironmentVariable("SAP_PASSWORD_CLIENTEX", $plain, "User")
   $plain = $null; Remove-Variable secure
   ```
3. Abra um PowerShell novo (herda as env vars) e rode `claude`.
4. No Claude Code: *"liste minhas instâncias"*, depois *"conecta no cliente X"*.

A senha **nunca** fica no `instances.json` — só o nome da variável. O arquivo
está no `.gitignore` (contém host/usuário). Sem ele, o capitu usa as env vars
`SAP_*` como instância única.

> ⚠️ **Escrita é read-only por padrão por instância.** Uma instância só permite
> escrever objetos se o perfil declarar `"readOnly": false` (e `allowedPackages`).
> É proposital: protege produtivos. Se tentar escrever numa instância sem isso, o
> capitu avisa e mostra como liberar (sem reiniciar). Ver "Múltiplas instâncias"
> no [`README.md`](README.md) para os campos de safety, auth (cookie/bearer) e
> visibilidade de tools.

## Próximos passos

- Veja [`README.md`](README.md) para entender as 49 tools disponíveis
- Veja [`ARCHITECTURE.md`](ARCHITECTURE.md) para entender o design dos 3 agentes
- Teste a primeira tool: `Use capituDevSearch para procurar objetos ZI_* do tipo DDLS`
