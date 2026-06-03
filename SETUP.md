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
| `Server disconnected` | Variável de ambiente faltando | Veja `[Environment]::GetEnvironmentVariable("SAP_PASSWORD", "User").Length` |
| `401 Unauthorized` | Senha errada ou conta bloqueada | Teste no SAP GUI primeiro |
| `403 stateful session required` | Bug raro do MCP | Reabra Claude Code |
| `master description in original language` | `SAP_LANGUAGE` errado | Confirme idioma original do sistema (PT, EN, DE...) |
| `corrNr could not be found` | Pacote exige transport | Use `capituDevListTransports` para escolher uma TR aberta |
| Tools não aparecem em `/mcp` | Claude Code carregou config antiga | Feche e abra novamente o Claude Code |

## Habilitando escrita ABAP

Se você não habilitou escrita no instalador e quer fazer depois, edite `.mcp.json`, no servidor `capitu-dev`:

- `CAPITU_ALLOW_WRITES`: `"true"`
- `CAPITU_ALLOWED_PACKAGES`: `"$TMP,<seu-pacote>"` (CSV, suporta wildcard `Z*`)

Reinicie o Claude Code para aplicar.

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

- Veja [`README.md`](README.md) para entender as 48 tools disponíveis
- Veja [`ARCHITECTURE.md`](ARCHITECTURE.md) para entender o design dos 3 agentes
- Teste a primeira tool: `Use capituDevSearch para procurar objetos ZI_* do tipo DDLS`
