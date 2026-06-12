# ============================================================================
# Capitu MCP — Installer
#
# Cria .mcp.json a partir do template, salva credenciais como variáveis de
# ambiente persistentes (escopo User do Windows), e roda npm install.
#
# Uso:
#   .\install.ps1
#
# Nada é enviado para qualquer servidor remoto. Tudo fica local. A senha SAP
# entra apenas no Windows Credential Store via SetEnvironmentVariable e nunca
# é gravada em arquivo.
# ============================================================================

$ErrorActionPreference = 'Stop'

function Write-Header($text) {
    Write-Host ""
    Write-Host ("═" * 70) -ForegroundColor Cyan
    Write-Host $text -ForegroundColor Cyan
    Write-Host ("═" * 70) -ForegroundColor Cyan
}

function Write-Step($n, $text) {
    Write-Host ""
    Write-Host "[$n] $text" -ForegroundColor Yellow
}

function Read-NonEmpty($prompt) {
    do {
        $value = Read-Host $prompt
        if (-not $value) { Write-Host "  Valor obrigatório, tente novamente." -ForegroundColor Red }
    } while (-not $value)
    return $value
}

function Read-WithDefault($prompt, $default) {
    $value = Read-Host "$prompt [$default]"
    if (-not $value) { return $default }
    return $value
}

Write-Header "Capitu MCP — Setup"

# ----- Pre-flight checks ----------------------------------------------------

Write-Step 1 "Checando pré-requisitos"

try {
    $nodeVersion = (node --version) 2>$null
    if (-not $nodeVersion) { throw "node não encontrado" }
    $major = [int]($nodeVersion -replace 'v(\d+)\..*', '$1')
    if ($major -lt 18) {
        Write-Host "  ⚠️  Node $nodeVersion detectado. Recomendado: 22 LTS." -ForegroundColor Yellow
        $cont = Read-Host "Continuar mesmo assim? (s/N)"
        if ($cont -ne 's') { exit 1 }
    } else {
        Write-Host "  ✓ Node $nodeVersion" -ForegroundColor Green
    }
} catch {
    Write-Host "  ✗ Node não está no PATH. Instale Node 22 LTS antes:" -ForegroundColor Red
    Write-Host "    winget install OpenJS.NodeJS.LTS" -ForegroundColor Gray
    exit 1
}

# Multi-Node guard. capitu depende de better-sqlite3 (módulo NATIVO compilado
# para um ABI específico do Node). Se você tem mais de um Node instalado (ex:
# um Node do nvm + o Node global que o Claude usa), o `npm install` precisa
# rodar com o MESMO Node que o Claude lança os servidores — senão o binário
# nasce para o ABI errado e os 3 servidores quebram no boot. Detectamos o
# divergência cedo e oferecemos alinhar.
$claudeNode = "C:\Program Files\nodejs\node.exe"
if (Test-Path $claudeNode) {
    $claudeNodeVersion = (& $claudeNode --version) 2>$null
    $currentNodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
    if ($claudeNodeVersion -and $claudeNodeVersion -ne $nodeVersion) {
        Write-Host ""
        Write-Host "  ⚠️  Node do PATH ($nodeVersion) ≠ Node em Program Files ($claudeNodeVersion)." -ForegroundColor Yellow
        Write-Host "     O Claude normalmente usa o de Program Files. Instalar com um Node" -ForegroundColor Gray
        Write-Host "     diferente faz o better-sqlite3 (nativo) quebrar no boot dos servidores." -ForegroundColor Gray
        $align = Read-Host "Usar o Node de Program Files para o install? (S/n)"
        if ($align -ne 'n') {
            $env:Path = "C:\Program Files\nodejs;$env:Path"
            $nodeVersion = (node --version) 2>$null
            Write-Host "  ✓ Alinhado: install vai usar Node $nodeVersion" -ForegroundColor Green
        } else {
            Write-Host "  → Mantendo Node $nodeVersion. Se os servidores quebrarem, rode:" -ForegroundColor Gray
            Write-Host "      `$env:Path = `"C:\Program Files\nodejs;`$env:Path`"; npm run rebuild:native" -ForegroundColor Gray
        }
    }
}

# Claude Code CLI — não bloqueia o setup, mas é necessário para USAR o capitu.
# O passo final ('claude') falha sem ele, então avisamos cedo.
try {
    $claudeVersion = (claude --version) 2>$null
    if ($claudeVersion) {
        Write-Host "  ✓ Claude Code CLI ($claudeVersion)" -ForegroundColor Green
    } else {
        throw "claude não encontrado"
    }
} catch {
    Write-Host "  ⚠️  Claude Code CLI não está no PATH." -ForegroundColor Yellow
    Write-Host "     O setup continua, MAS você vai precisar dele para usar o capitu." -ForegroundColor Gray
    Write-Host "     Instale em: https://code.claude.com (requer conta Anthropic ativa)." -ForegroundColor Gray
}

# git — informativo (você já clonou se chegou aqui, mas confirma o ambiente).
try {
    $gitVersion = (git --version) 2>$null
    if ($gitVersion) { Write-Host "  ✓ $gitVersion" -ForegroundColor Green }
} catch {
    Write-Host "  ⚠️  git não está no PATH (não é obrigatório para o setup)." -ForegroundColor Yellow
}

if (-not (Test-Path ".mcp.example.json")) {
    Write-Host "  ✗ .mcp.example.json não encontrado. Rode este script da raiz do projeto." -ForegroundColor Red
    exit 1
}

Write-Host "  ✓ Template .mcp.example.json encontrado" -ForegroundColor Green

# ----- Detect existing config ----------------------------------------------

if (Test-Path ".mcp.json") {
    Write-Host ""
    Write-Host "  ⚠️  .mcp.json já existe." -ForegroundColor Yellow
    $overwrite = Read-Host "Sobrescrever? (s/N)"
    if ($overwrite -ne 's') {
        Write-Host "  Mantendo .mcp.json existente. Sair." -ForegroundColor Gray
        exit 0
    }
}

# ----- Collect SAP connection -----------------------------------------------

Write-Step 2 "Configuração de conexão SAP"

$sapUrl = Read-NonEmpty "URL do tenant SAP (ex: https://sap.exemplo.com:8100)"
$sapUser = Read-NonEmpty "Usuário SAP"
$sapClient = Read-NonEmpty "Mandant (ex: 100)"
$sapLanguage = Read-WithDefault "Idioma de logon" "PT"

# ----- Collect password securely -------------------------------------------

Write-Step 3 "Senha SAP (será gravada como env var persistente do Windows, nunca em arquivo)"

$sapSecure = Read-Host -AsSecureString "Senha SAP"
$sapPassword = [System.Net.NetworkCredential]::new("", $sapSecure).Password

if (-not $sapPassword) {
    Write-Host "  ✗ Senha vazia. Abortando." -ForegroundColor Red
    exit 1
}

[Environment]::SetEnvironmentVariable("SAP_PASSWORD", $sapPassword, "User")
$savedLen = [Environment]::GetEnvironmentVariable("SAP_PASSWORD", "User").Length
Write-Host "  ✓ Senha salva no escopo User do Windows ($savedLen caracteres)" -ForegroundColor Green

# Clear in-memory copy ASAP
$sapPassword = $null
Remove-Variable sapSecure -ErrorAction SilentlyContinue

# ----- Optional: Voyage API key --------------------------------------------

Write-Step 4 "Embeddings (opcional)"
Write-Host "  Capitu usa embeddings para busca semântica. Três opções:" -ForegroundColor Gray
Write-Host "    1. bm25      — sem embeddings, busca por palavras-chave (padrão, zero custo)" -ForegroundColor Gray
Write-Host "    2. voyage    — Voyage AI (free tier 200M tokens, qualidade alta)" -ForegroundColor Gray
Write-Host "    3. local     — Modelo HuggingFace local (só se rede liberar huggingface.co)" -ForegroundColor Gray
Write-Host ""

$embedChoice = Read-WithDefault "Escolha (bm25/voyage/local)" "bm25"

if ($embedChoice -eq 'voyage') {
    $voyageSecure = Read-Host -AsSecureString "VOYAGE_API_KEY (cole a chave inteira)"
    $voyageKey = [System.Net.NetworkCredential]::new("", $voyageSecure).Password
    if ($voyageKey) {
        [Environment]::SetEnvironmentVariable("VOYAGE_API_KEY", $voyageKey, "User")
        Write-Host "  ✓ VOYAGE_API_KEY salva" -ForegroundColor Green
    }
    $voyageKey = $null
    Remove-Variable voyageSecure -ErrorAction SilentlyContinue
}

# ----- Write allowance ------------------------------------------------------

Write-Step 5 "Permissões de escrita"
Write-Host "  Por padrão, capitu NÃO escreve no SAP. Para liberar escrita em pacotes específicos:" -ForegroundColor Gray

$allowWrites = Read-WithDefault "Habilitar escrita ABAP via capitu-dev? (s/N)" "n"
$writesEnabled = $allowWrites -eq 's'
$allowedPackages = '$TMP'

if ($writesEnabled) {
    Write-Host "  ⚠️  Você está habilitando escrita real no SAP. Confirme o(s) pacote(s) permitido(s)." -ForegroundColor Yellow
    $allowedPackages = Read-WithDefault "Pacotes permitidos (CSV, suporta wildcard Z*)" '$TMP'
}

# ----- Generate .mcp.json ---------------------------------------------------

Write-Step 6 "Gerando .mcp.json"

$projectPath = (Get-Location).Path
# JSON requires backslashes to be escaped (\\)
$projectPathJson = $projectPath -replace '\\', '\\'
$homePathJson = $env:USERPROFILE -replace '\\', '\\'

$template = Get-Content .mcp.example.json -Raw
$config = $template `
    -replace '<CAMINHO_ABSOLUTO_DO_PROJETO>', $projectPathJson `
    -replace '<URL_DO_SEU_TENANT>', $sapUrl `
    -replace '<SEU_USUARIO_SAP>', $sapUser `
    -replace '<MANDANT>', $sapClient `
    -replace '<IDIOMA>', $sapLanguage `
    -replace '<HOME>', $homePathJson

# Adjust CAPITU_EMBEDDINGS if user picked something other than bm25
if ($embedChoice -ne 'bm25') {
    $config = $config -replace '"CAPITU_EMBEDDINGS": "bm25"', "`"CAPITU_EMBEDDINGS`": `"$embedChoice`""
}

# Adjust writes if enabled
if ($writesEnabled) {
    $config = $config -replace '"CAPITU_ALLOW_WRITES": "false"', '"CAPITU_ALLOW_WRITES": "true"'
    $escapedPackages = $allowedPackages -replace '\$', '\$'
    $config = $config -replace '"CAPITU_ALLOWED_PACKAGES": "\$TMP"', "`"CAPITU_ALLOWED_PACKAGES`": `"$escapedPackages`""
}

# Remove the leading "_comment" line — it's just instructional
$config = $config -replace '\s*"_comment":[^,]+,', ''

$config | Out-File -FilePath .mcp.json -Encoding utf8
Write-Host "  ✓ .mcp.json gerado" -ForegroundColor Green

# ----- npm install ----------------------------------------------------------

Write-Step 7 "Instalando dependências (pode demorar 1-3 min)"

npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ✗ npm install falhou. Veja o erro acima." -ForegroundColor Red
    exit 1
}
Write-Host "  ✓ Dependências instaladas" -ForegroundColor Green

# Verifica que o módulo nativo (better-sqlite3) carrega no Node atual. O
# postinstall já roda isso, mas confirmamos aqui e oferecemos o rebuild se o
# binário tiver nascido para o ABI errado (multi-Node).
& node scripts/check-native.mjs
& node -e "require('better-sqlite3')" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  ⚠️  O módulo nativo não carregou. Tentando rebuild com o Node atual..." -ForegroundColor Yellow
    npm run rebuild:native
    & node -e "require('better-sqlite3')" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ✗ Ainda não carrega. Veja SETUP.md → Troubleshooting (better-sqlite3)." -ForegroundColor Red
    } else {
        Write-Host "  ✓ Módulo nativo OK após rebuild" -ForegroundColor Green
    }
}

# ----- Optional smoke test --------------------------------------------------

Write-Step 8 "Validação opcional"

$runSmoke = Read-WithDefault "Rodar smoke test contra SAP agora? (s/N)" "n"
if ($runSmoke -eq 's') {
    $env:SAP_URL = $sapUrl
    $env:SAP_USER = $sapUser
    $env:SAP_CLIENT = $sapClient
    if (Test-Path "scripts/smoke-test-adt.ts") {
        npm run smoke:adt
    } else {
        Write-Host "  scripts/smoke-test-adt.ts não está disponível (gitignored). Pulando." -ForegroundColor Gray
    }
}

# ----- Done -----------------------------------------------------------------

Write-Header "Setup completo!"

Write-Host ""
Write-Host "Próximos passos:" -ForegroundColor White
Write-Host "  1. Abra um NOVO PowerShell (para herdar as env vars salvas)" -ForegroundColor Gray
Write-Host "  2. Rode:    " -NoNewline -ForegroundColor Gray
Write-Host "claude" -ForegroundColor Cyan
Write-Host "  3. No Claude Code, rode: " -NoNewline -ForegroundColor Gray
Write-Host "/mcp" -ForegroundColor Cyan
Write-Host "     Os 3 servidores capitu devem aparecer como ✓ connected" -ForegroundColor Gray
Write-Host ""
Write-Host "Se algo falhar, veja SETUP.md (seção Troubleshooting)." -ForegroundColor Gray
Write-Host ""
