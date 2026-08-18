# INSTRUÇÃO AUTOMÁTICA
Ao iniciar cada sessão, LEIA este AGENTS.md inteiro. Ao FINALIZAR qualquer tarefa ou conversa, ATUALIZE este arquivo com tudo que foi feito, decidido, corrigido ou descoberto — SEMPRE, sem o usuário precisar pedir. Salve tudo: erros encontrados, soluções aplicadas, configurações mudadas, o que funciona e o que não funciona.

# Projeto: Integração Mercado Pago + Finassets (Crypto)

## O que é
Página de perfil (Martina Olvr) com planos de assinatura que precisa de integração real com Mercado Pago para pagamentos (Pix, Cartão, Boleto) E Finassets para pagamentos com criptomoedas.

## Arquivos do projeto
- `index.html` — Página principal com layout dos planos (Mensal R$15, Trimestral R$60, Semestral R$105)
- `server.js` — Servidor Node.js na porta 8080 (servidor arquivos estáticos + API)
- `package.json` — Dependências: mercadopago, dotenv, uuid
- `.env` — Credenciais (Access Token + Public Key + Finassets keys)

## Como rodar
```bash
npm start
```
Acesse http://localhost:8080

## Documentação Mercado Pago estudada (Orders API)

### API Principal
- Orders API: `POST /v1/orders` — API recomendada pelo Mercado Pago
- SDK Node.js: pacote `mercadopago` (npm)
- Classe: `MercadoPagoConfig` + `Order`

### Fluxo Cartão de Crédito
1. Frontend carrega MercadoPago.js SDK (usando Public Key)
2. Frontend usa createCardToken para tokenizar o cartão
3. Frontend envia o card token + dados do pagador para o backend
4. Backend detecta bandeira do cartão automaticamente (visa/master/elo/amex)
5. Backend cria Order via `POST /v1/orders` com o token
6. Order retorna status `processed` ou `action_required` (3DS)

### Fluxo Pix
1. Backend cria Order com `payment_method.id: "pix"`, `type: "bank_transfer"`
2. Response retorna: `qr_code`, `qr_code_base64`, `ticket_url`
3. Frontend exibe QR code (220x220px, fundo branco) + código copia-e-cola
4. Status inicial: `action_required` com `status_detail: "waiting_transfer"`
5. Pagamento aprovado muda para `processed` com `status_detail: "accredited"`
6. Frontend faz polling a cada 5s pra verificar status

### Fluxo Boleto
1. Backend cria Order com `payment_method.id: "boleto"`, `type: "bank_transfer"`
2. Response retorna `ticket_url` com o boleto
3. Status inicial: `action_required` com `status_detail: "waiting_payment"`

### Idempotência (OBRIGATÓRIO)
- Header: `X-Idempotency-Key` (UUID V4, 1-150 chars)
- Previne duplicação de pagamentos
- Implementado em todas as chamadas de criação de Order

### Credenciais
- Access Token: usado SOMENTE no backend, começa com `APP_USR`
- Public Key: usada no frontend para MercadoPago.js SDK
- Webhook Secret: usado para validar notificações (configurar no painel MP)

### Notificações (Webhooks) — Tutorial Completo

**Fonte:** https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/notifications

#### O que são Webhooks
As notificações Webhooks permitem ao Mercado Pago enviar informações em **tempo real** quando ocorre um evento específico na integração. Em vez de consultar constantemente o status, o sistema envia automaticamente um POST HTTPS para a sua URL configurada.

#### Passo a passo para configurar Webhooks no painel do MP
1. Acesse **Suas integrações** (https://www.mercadopago.com.br/developers/panel/app) e selecione o app integrado
2. No menu lateral: **Webhooks > Configurar notificações**
3. Na aba **Modo de produção**, informe a URL HTTPS (ex: `https://seudominio.com/webhooks/mercadopago`)
   - Para identificar múltiplas contas, adicione `?client=(nomedovendedor)` ao final da URL
4. Selecione o evento **Order (Mercado Pago)** — notificações são enviadas em JSON via HTTPS POST
5. Clique em **Salvar configuração** — será gerada uma chave secreta exclusiva para validação
   - A chave não tem prazo de validade
   - Renovação periódica é opcional (botão "Redefinir")

#### Simular notificação (teste)
1. Após configurar, clique em **Simular notificação**
2. Selecione a URL a ser testada
3. Escolha o tipo de evento e insira o ID no campo **Data ID**
4. Clique em **Enviar teste** para verificar request, response e descrição do evento

#### Corpo da notificação recebida (exemplo)
```json
{
  "action": "order.action_required",
  "api_version": "v1",
  "application_id": "76506430185983",
  "date_created": "2021-11-01T02:02:02Z",
  "id": "123456",
  "live_mode": false,
  "type": "order",
  "user_id": 2025701502,
  "data": {
    "id": "ORD01JQ4S4KY8HWQ6NA5PXB65B3D3"
  }
}
```

**Estrutura da notificação:**
- **Query params**: `data.id=ORD01...&type=order`
- **Body**: `action`, `api_version`, `application_id`, `date_created`, `id`, `live_mode`, `type`, `user_id`, `data`
- **Header**: inclui `x-signature` (assinatura secreta), `x-request-id`, etc.

#### Validar origem da notificação (HMAC SHA256)
1. Extrair `ts` e `v1` do header `x-signature`:
   ```
   ts=1742505638683,v1=ced36ab6d33566bb1e16c125819b8d840d6b8ef136b0b9127c76064466f5229b
   ```
2. Montar o template com os dados da notificação:
   ```
   id:[data.id_url];request-id:[x-request-id_header];ts:[ts_header];
   ```
   - `data.id_url` → vem dos query params em **MAIÚSCULA**, mas deve ser usado em **MINÚSCULA**
   - Exemplo: `id:ord01jq4s4ky8hwq6na5pxb65b3d3;request-id:2066ca19-c6f1-498a-be75-1923005edd06;ts:1742505638683;`
3. Obter a chave secreta em **Suas integrações > Webhooks > Configurar notificação**
4. Calcular **HMAC SHA256** em base hexadecimal: chave = secret, mensagem = template montado
5. Comparar o resultado com `v1` extraído do header (deve ser igual)
6. Opcional: comparar `ts` extraído com timestamp atual para verificar tolerância de atraso

#### Ações após receber a notificação
- Responder **HTTP 200 (OK)** ou **201 (CREATED)** — obrigatório
- Timeout de espera: **22 segundos**
- Se não responder, o MP tenta reenviar a cada **15 minutos** (mínimo 3 tentativas)
- Após confirmar recebimento, fazer **GET** em `/v1/orders/{id}` para obter detalhes completos e atualizar a plataforma

#### Configuração no painel (resumo visual)
1. App > Webhooks > Configurar notificações
2. Aba "Modo de produção" > URL HTTPS
3. Evento: "Order (Mercado Pago)"
4. Salvar > chave secreta gerada
5. Usar chave para validar HMAC nas notificações recebidas

#### Rota no backend
- POST /webhooks/mercadopago — Recebe notificações webhook

### Status dos Orders
| status | status_detail | Descrição |
|--------|---------------|-----------|
| created | created | Criado, sem processamento |
| processing | in_process | Processando |
| processed | accredited | Pago com sucesso |
| action_required | waiting_payment | Aguardando pagamento (boleto) |
| action_required | waiting_transfer | Aguardando transferência (pix) |
| action_required | waiting_capture | Aguardando captura |
| canceled | canceled | Cancelado |
| expired | expired | Expirado |
| failed | failed | Falhou |
| refunded | refunded | Estornado |
| charged_back | in_process | Chargeback em análise |

### Rotas do backend
- `POST /api/create-order` — Cria Order no MP
- `GET /api/public-key` — Retorna Public Key para o frontend
- `GET /api/order/{id}` — Consulta status de uma Order
- `POST /webhooks/mercadopago` — Recebe notificações webhook

### Limitações do Sandbox
- Apenas Pix funciona no sandbox do Orders API
- Cartão e Boleto retornam erro no sandbox
- Cartão e Boleto funcionam normalmente em produção
- Email do payer deve ser `@testuser.com` no sandbox

### Detecção automática de bandeira (server.js)
- Visa: começa com 4
- Mastercard: começa com 5[1-5] ou 2[2-7]
- Elo: bins específicos (4011, 4312, 4573, etc)
- Amex: começa com 3[47]
- Fallback: master

## Credenciais e Tokens
**ATENÇÃO: Todos os tokens estão no arquivo `.env` (gitignored, não commitado).**
Leia `/public/.env` no início de cada sessão pra acessar:
- `GITHUB_PAT` — GitHub Personal Access Token (push ao repo)
- `VERCEL_TOKEN` — Vercel API token (gerenciar env vars e deploys)
- `VERCEL_TEAM_ID` — Team ID do Vercel
- `MP_ACCESS_TOKEN` — Mercado Pago Access Token (**PRODUÇÃO**)
- `MP_PUBLIC_KEY` — Mercado Pago Public Key (**PRODUÇÃO**)
- `MP_WEBHOOK_SECRET` — Secret do webhook (**PRODUÇÃO**)

## GitHub
- Repositório: https://github.com/Web-site-007/martina-olvr
- Branch: main
- Usuário: Web-site-007

## Vercel
- Projeto: martina-olvr
- URL: https://martina-olvr.vercel.app
- Team ID: team_Jsgk9L2xfoU6oD9ocXnotlAA
- Project ID: prj_1K4Ki4gtZ4brwR2XxzfvUpyNSeZ1
- Token: (salvo localmente, não commitado por segurança)

## Status do projeto
- [x] Documentação Mercado Pago estudada
- [x] Credenciais de teste recebidas (Access Token + Public Key)
- [x] Criar package.json
- [x] Criar .env
- [x] Instalar dependências (npm install)
- [x] Criar server.js com rotas da API
- [x] Atualizar index.html com MercadoPago.js SDK
- [x] Testar fluxo Pix (sandbox) — OK
- [x] Testar tokenização de cartão (API) — OK
- [x] Detecção automática de bandeira do cartão
- [x] Layout customizado (QR code, código copia, formulário cartão)
- [x] Validar webhook HMAC SHA256 no server.js
- [x] Documentar tutorial completo de notificações Webhooks no AGENTS.md
- [x] Melhorias de qualidade da integração (description, entity_type, category_id, items, etc)
- [x] Resolver limitações do SDK v2.13.0 (usar raw HTTP pro POST /v1/orders)
- [x] Formulário completo: endereço (street, number, zip, city, state) em todos os métodos
- [x] Nome/sobrenome/CPF obrigatórios para Pix e Boleto (não só cartão)
- [x] Device ID (X-meli-session-id) enviado no header da criação de Order
- [x] additional_info.payer.registration_date enviado na criação da Order
- [x] payer.address completo (street_name, street_number, zip_code, city, state)
- [x] Criar conta no GitHub
- [x] Criar repositório e subir código
- [x] Criar conta no Vercel
- [x] Subir site no Vercel (Node.js serverless)
- [x] Configurar variáveis de ambiente no Vercel (MP_ACCESS_TOKEN, MP_PUBLIC_KEY, MP_WEBHOOK_SECRET)
- [x] Configurar webhook no painel Mercado Pago (sandbox)
- [x] Adicionar endpoints OAuth (/oauth/authorize, /oauth/callback) para qualidade MP
- [x] Gerar credenciais de produção no Mercado Pago
- [x] Trocar credenciais pra produção no Vercel (Access Token + Public Key)
- [x] Configurar Webhook em produção (URL + Evento Order + Secret)
- [x] Adicionar MP_SITE_URL e MP_NOTIFICATION_URL ao Vercel
- [x] Corrigir site 404 no Vercel (catch-all + includeFiles)
- [ ] Testar pagamento em produção (usando CONTA DIFERENTE do MP — comprador não pode ser o vendedor)
- [ ] Confirmar que webhook dispara ao receber pagamento
- [ ] Medir qualidade MP novamente (meta: 100/100)

## Medição de Qualidade MP (14 itens)
**Data:** 18/ago/2026 | **Resultado:** 79/100 | **Pendente:** 4 tarefas

### Status dos requisitos
| Requisito | Status | Nota |
|-----------|--------|------|
| SDK do frontend | ✅ Implementado | `sdk.mercadopago.com/js/v2` + inicialização |
| OAuth | ✅ Endpoints criados | `/oauth/authorize` + `/oauth/callback` |
| Webhook | ✅ Configurado | Produção ativa, secret configurado |
| Integrator ID | ❌ Não se aplica | Só para Programa de Parcerias |

### Ação necessária
1. Usuário precisa testar pagamento real pra webhook disparar
2. Depois medir qualidade novamente — deve subir pra 100/100

## Para ir pra produção

### Passo a passo (feito pelo usuário)

**1. Criar conta no GitHub**
- Acesse github.com, crie conta gratuita

**2. Criar repositório no GitHub**
- New repository > nome: `martina-olvr`
- Me mandar o link (ex: `github.com/seunome/martina-olvr`)

**3. Criar conta no Vercel ou Railway**
- Vercel (vercel.com) ou Railway (railway.app)
- Fazer login com conta do GitHub
- Conectar o repositório
- Hosting sobe automaticamente com Node.js

**4. Pegar credenciais de produção no Mercado Pago**
- Acessar mercadopago.com.br > Seus integrações
- Criar aplicação
- Copiar Access Token e Public Key de produção

**5. Configurar Webhook no painel MP**
- Webhooks > Configurar notificações
- URL: `https://seusite.com/webhooks/mercadopago`
- Evento: Order (Mercado Pago)
- Salvar > copiar chave secreta

**6. Me mandar:**
- Credenciais de produção (Access Token + Public Key)
- URL do site no hosting
- Chave secreta do webhook

**7. Eu faço:**
- Atualizar .env com credenciais de produção
- Configurar MP_WEBHOOK_SECRET
- Testar webhook com Order ID de teste

### Importante: Hosting
- **Netlify NÃO funciona** — é só estático, não roda Node.js
- Usar **Vercel** ou **Railway** — suportam Node.js
- **vercel.json DEVE ter catch-all** mandando tudo pro server.js + `includeFiles` pra incluir imagens/assets no bundle do Lambda
- O server.js já tem lógica pra servir arquivos estáticos (fs.readFile), então o catch-all funciona corretamente
- SEM catch-all, arquivos estáticos (HTML, imagens) retornam 404 no Vercel

### Order ID de teste pra webhook
- Último Order ID gerado (sandbox): `ORDTST01M08RR7JW74RCNCYGC8VXAMM4`
- Para gerar novo: rodar `npm start`, acessar localhost:8080, fazer pagamento Pix
- Usar esse ID no painel MP pra simular notificação webhook

## Erros corrigidos (18/ago/2026)

### 1. Erro `invalid_users_involved` no Pix
- **Erro:** `PAY01M09S1ZCESTKYHB7R7H3JDCKE: invalid_users_involved`
- **Causa:** O comprador e o vendedor eram a mesma conta do Mercado Pago
- **Solução:** O comprador precisa usar uma conta DIFERENTE do MP (outro CPF e email)
- **Regra MP:** Não é possível pagar a si mesmo

### 2. Detecção de sandbox errada (email forçado pra @testuser.com)
- **Bug:** `isSandbox` usava `!token.includes('production')` — tokens de produção não contêm "production"
- **Resultado:** Todos os emails eram forçados pra `@testuser.com` em produção
- **Correção:** Removida a lógica de sandbox detection — email enviado como o usuário digita

### 3. Elo cards detectados como Mastercard
- **Bug:** Checagem Elo vinha DEPOIS de Mastercard no `detectCardBrand()`
- **Resultado:** Cartões Elo 5041/5066/5067 eram detectados como Mastercard (`5[1-5]`)
- **Correção:** Elo checado ANTES de Mastercard (e Amex antes dos dois)

### 4. Path traversal no server.js
- **Bug:** `path.join(__dirname, url)` com `../` no URL podia acessar arquivos fora do diretório
- **Correção:** Validação `filePath.startsWith(__dirname)` antes de servir arquivo

### 5. Variável `body` sobrescrevendo parâmetro no mpPost
- **Bug:** `let body = ''` na response callback sobrescia o parâmetro `body` da function
- **Correção:** Renomeada pra `responseBody`

### 6. Formulário Pix/Boleto sumia após erro
- **Bug:** Após erro na criação da Order, `pixForm`/`boletoForm` ficava com `display: none`
- **Resultado:** Usuário não conseguia corrigir dados e retry
- **Correção:** Formulário exibido novamente no catch

### 7. Cartão não validava endereço
- **Bug:** `payWithCard()` só validava email/nome/CPF/cartão, ignorando CEP/rua/cidade/estado
- **Correção:** Adicionada validação de endereço completo

### 8. Footer com ano 2025
- **Correção:** Atualizado pra 2026

### 9. Imagem avatar 404 no Vercel
- **Bug:** `vercel.json` tinha catch-all `"src": "/(.*)"` mandando TUDO pro serverless
- **Resultado:** Lambda do Vercel não tem acesso a arquivos estáticos (imagens, HTML)
- **Correção:** Só `/api/*`, `/webhooks/*`, `/oauth/*` vão pro Lambda; resto é servido estaticamente pelo Vercel

### 10. Site 404 no Vercel (todas as rotas)
- **Bug:** Com routes só pra API, arquivos estáticos (index.html, imagens) retornavam 404
- **Resultado:** O Vercel não servia arquivos estáticos automaticamente quando o projeto usa `builds` config
- **Correção:** Adicionar catch-all `"src": "/(.*)", "dest": "server.js"` + `"includeFiles": ["images/**", "assets/**", "api/**"]` no build config
- **Por que funciona agora:** O server.js tem lógica de servir arquivos estáticos via `fs.readFile`, e o `includeFiles` garante que imagens/assets entrem no bundle do Lambda
- **Anotação:** O `handle: "filesystem"` do Vercel NÃO funcionou pra este caso

### 11. Código Pix "copia e cola" parecia pequeno demais
- **Bug:** A textarea tinha `rows="3"`, escondendo a maior parte do código EMV (300+ chars)
- **Usuário confundia:** Achava que era "chave Pix" e tentava colar na opção errada do banco
- **Correção:** Textarea aumentada pra `rows="6"`, adicionado link pro `ticket_url` (página MP com QR code + código completo), e instrução clara: "No app do banco,选择 a opção Pix copia e cola"
- **Nota:** O campo `qr_code` da Orders API é o EMV completo (começa com `00020126580014br.gov.bcb.pix...`), NÃO é uma "chave Pix"

### Detecção de bandeira (ordem corrigida)
```
1. Visa: /^4/
2. Amex: /^3[47]/
3. Elo: /^(4011|4312|4573|4574|5041|5066|5067|6277|6362|6504|6505|6516)/
4. Mastercard: /^5[1-5]/ ou /^2[2-7]/
5. Discover: /^6(?:011|5)/ (usa rede master no MP)
6. Fallback: master
```

## Observações
- Access Token NUNCA no frontend
- Usar idempotência em todas as operações de pagamento
- Usar variáveis de ambiente para credenciais
- O formulário de pagamento é 100% customizado (sem usar Brick do MP)
- Token do cartão é gerado pelo SDK do MP no navegador (segurança)
- Webhook Secret configurado em produção

## Limitações do SDK v2.13.0

O SDK Node.js do Mercado Pago (v2.13.0) tem validação estrita no método `Order.create()` que rejeita campos que a API aceita:

### Campos rejeitados pelo SDK
| Campo | Erro do SDK | Status na API |
|-------|-------------|---------------|
| `notification_url` | `additionalProperties not allowed` | **NÃO existe** no body da Orders API |
| `payment_method.type: "bank_transfer"` | `value must be one of credit_card, debit_card, account_money, digital_currency, wallet` | API aceita, mas SDK bloqueia |

### Solução implementada
Usar **HTTP direto** (`https.request`) pra criação de Orders ao invés do SDK:

```js
async function mpPost(path, body, idempotencyKey, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = {
      'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': idempotencyKey,
      'Content-Length': Buffer.byteLength(data),
      ...extraHeaders
    };
    const req = https.request({
      hostname: 'api.mercadopago.com',
      port: 443,
      path,
      method: 'POST',
      headers
    }, (res) => {
      let responseBody = '';
      res.on('data', c => responseBody += c);
      res.on('end', () => {
        try { resolve(JSON.parse(responseBody)); }
        catch { reject(new Error('Resposta inválida do MP')); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
```

### Campos suportados pela Orders API (testados)
| Campo | Tipo | Suportado |
|-------|------|-----------|
| `type` | string | Sim: `"online"` |
| `processing_mode` | string | Sim: `"automatic"` ou `"manual"` |
| `capture_mode` | string | **SÓ CARTÃO** (`"automatic"`). Pix/Boleto rejeitam. |
| `total_amount` | string | Sim |
| `description` | string | Sim |
| `external_reference` | string | Sim |
| `payer.email` | string | Sim |
| `payer.entity_type` | string | Sim: `"individual"` |
| `payer.first_name` | string | Sim |
| `payer.last_name` | string | Sim |
| `payer.identification` | object | Sim: `{type: "CPF", number: "..."}` |
| `payer.address` | object | Sim: `{street_name, street_number, zip_code, city, state}` |
| `payment_method.id` | string | Sim: `"pix"`, `"boleto"`, `"visa"`, `"master"`, etc |
| `payment_method.type` | string | `"credit_card"`, `"debit_card"`, `"account_money"` |
| `payment_method.statement_descriptor` | string | Sim (só cartão) |
| `items[].title` | string | Sim |
| `items[].description` | string | Sim |
| `items[].unit_price` | string | Sim |
| `items[].quantity` | number | Sim |
| `items[].category_id` | string | Sim |
| `items[].picture_url` | string | Sim |
| `additional_info.payer.registration_date` | string | Sim (ISO 8601) |
| `X-meli-session-id` | header | Sim (Device ID para fraude) |
| `notification_url` | string | **NÃO existe** — configurar no painel MP |

### capture_mode — Por que só cartão?
- **Cartão de crédito**: tem autorização (hold) + captura (cobrar). `capture_mode` controla isso.
- **Pix**: pagamento instantâneo. Não existe fluxo autorizar/depois capturar.
- **Boleto**: cliente paga no banco/caixa. Sem fluxo autorização/captura.

## Medição de Qualidade MP (14 itens)
**Data:** 17/ago/2026 | **Resultado:** Abaixo do ideal | **Order ID:** ORDTST01M08QAR67ZRZEJX1Y9JP1KDVX

### Aspectos avaliados
| Aspecto | Status |
|---------|--------|
| Aprovação dos pagamentos | 7 tarefas pendentes |
| Experiência de compra (Transacional) | 7 tarefas pendentes |
| Segurança | 3 tarefas pendentes |
| Escalabilidade | Avaliado |
| Conciliação financeira | Avaliado |

### Campos de qualidade adicionados ao server.js
- `description` — Descrição da Order
- `payer.entity_type: "individual"` — Tipo de entidade do pagador
- `items[].description` — Descrição detalhada do item
- `items[].category_id` — Categoria do item
- `items[].picture_url` — URL da imagem do item
- `payment_method.statement_descriptor` — Nome no extrato (cartão)
- `capture_mode: "automatic"` — Só pra cartão
- `payer.address.*` — Endereço completo (street_name, street_number, zip_code, city, state)
- `additional_info.payer.registration_date` — Data de registro do pagador
- `X-meli-session-id` — Device ID para prevenção de fraude
- `payer.first_name`, `payer.last_name`, `payer.identification` — Dados do pagador para todos os métodos

### O que NÃO é possível via API (só painel)
- `notification_url` — Configurar em **Suas integrações > Webhooks > Configurar notificações**
- Webhook Secret — Gerado automaticamente ao configurar webhook no painel
- Ativar/Desativar meios de pagamento — Painel do MP
- OAuth — Só para plataformas multi-vendedor
- Integrator ID — Só para desenvolvedores certificados do Programa de Parcerias

---

# Integração Finassets (Crypto)

## O que é
Gateway de pagamento com criptomoedas (USDT, BTC, ETH e mais de 70 moedas) com taxas a partir de 0.20%.

## Por que escolhemos
- **Taxa mais baixa do mercado**: 0.20% a 0.40% (vs 7% da DeFlow, 1% de outras)
- **Nome não aparece**: O comprador vê apenas endereço de carteira, não nome pessoal
- **Stablecoin support**: Aceita USDT (sem volatilidade)
- **API simples**: Criar checkout → redirecionar → webhook confirma

## Documentação Finassets

### API
- Base URL: `https://www.finassets.io/api`
- Docs: `https://www.finassets.io/api/doc`
- Sandbox: `https://stage.finassets.io/api` (basic auth, contato suporte)

### Autenticação
- Header `API-Key`: Chave da API
- Header `Api-Signature`: `Base64Encode(HMAC-SHA512(request_uuid + request_type + request_uri_part, secret_key))`
- Query param `request_uuid`: UUID único por requisição

### Fluxo Checkout (implementado)
1. Frontend clica "Pagar com Crypto"
2. Backend cria checkout via `POST /v1/checkout` com project key + items
3. Response retorna URL: `https://pay.finassets.io/checkout/xxx`
4. Usuário é redirecionado para página de pagamento
5. Paga com crypto (USDT, BTC, ETH, etc)
6. Finassets envia webhook quando pagamento confirma
7. Backend ativa assinatura

### Endpoints implementados
- `POST /api/create-checkout` — Cria checkout no Finassets
- `GET /api/checkout/:id` — Consulta status do checkout
- `POST /webhooks/finassets` — Recebe notificações webhook

### Variáveis de ambiente necessárias
```
FINASSETS_API_KEY=Sua API Key
FINASSETS_SECRET_KEY=Sua Secret Key
FINASSETS_PROJECT_KEY=Project Key do tipo Checkout
```

### Webhook
- Header: `Finassets-Signature` (HMAC-SHA512 do body)
- Retry: 1, 5, 10, 20, 40, 60, 120, 240, 360, 480, 600 minutos
- Resposta obrigatória: HTTP 200 em 30 segundos

### Configuração no painel Finassets
1. Criar conta em `https://www.finassets.io/en/account/register/`
2. Ir em **Settings > Integration & API Docs**
3. Criar API Key (salvar secret!)
4. Criar Project do tipo **Checkout** em **Payment Gateway > Projects**
5. Configurar Webhook URL em **Settings > Integration & API Docs**
6. Copiar Project Key e adicionar ao `.env`

### Limitações
- Sandbox requer contato com suporte (basic auth)
- API key tem rate limit de 100 req/min
- Checkout expira conforme configuração do projeto

---

# Sessão 18/ago/2026 — O que foi feito

## Problema original
- Irmão da Martina tem conta no Mercado Pago
- Quando clientes pagam via Pix/Boleto, **o nome do irmão aparece** no comprovante
- Queriam uma opção onde o nome pessoal **não aparece**

## Pesquisa realizada
1. **Mercado Pago** — Confirmado: Pix/Boleto SEMPRE mostra nome do titular. Não tem como mudar via API.
2. **DeFlow Exchange** — PIX↔DePix (Liquid Network). Taxa ~7% no depósito. **Muito cara, descartada.**
3. **GGPIXAPI** — PIX, boleto, cartão, crypto. Taxa ~0.77%. Boa opção PIX.
4. **Finassets** — Crypto gateway. Taxa **0.20% a 0.40%**. **Melhor custo-benefício, escolhida.**
5. Outras: Cryptomus (0.40%), NOWPayments (1%), BSPay (~1%)

## Solução escolhida: Finassets
- Taxa mais baixa do mercado (0.20-0.40%)
- Nome **não aparece** (só endereço de carteira)
- Aceita USDT (stablecoin, sem volatilidade)
- API simples: criar checkout → redirecionar → webhook confirma

## Implementação feita

### Backend (server.js)
- `signFinassetsRequest()` — Assina requests com HMAC-SHA512
- `finassetsRequest()` — Faz requests à API
- `validateFinassetsWebhook()` — Valida webhook
- `POST /api/create-checkout` — Cria checkout
- `GET /api/checkout/:id` — Consulta status
- `POST /webhooks/finassets` — Webhook receiver

### Frontend (index.html)
- Tab "Crypto" adicionada ao modal de pagamento
- CSS para features (Seguro, Rápido, Taxa baixa)
- Função `payWithCrypto()` — Cria checkout e redireciona
- `switchTab()` e `resetModal()` atualizados

### Deploy
- Git commit: `401b2e5`
- Push para GitHub: ✅
- Vercel: auto-deploy deve ativar em 1-2 min

## Status atual
- ✅ Código commitado e enviado pro GitHub
- ⏳ Aguardando deploy no Vercel
- ⏳ Tab "Crypto" deve aparecer no site em 1-2 min

## Próximos passos (quando voltar)
1. **Verificar se a tab Crypto aparece** no site (Ctrl+F5)
2. **Criar conta no Finassets:** https://www.finassets.io/en/account/register/
3. **Gerar API Key:** Settings > Integration & API Docs > Add API Key
4. **Criar Project:** Payment Gateway > Projects > Criar projeto do tipo "Checkout"
5. **Adicionar ao `.env` no Vercel:**
   ```
   FINASSETS_API_KEY=xxx
   FINASSETS_SECRET_KEY=xxx
   FINASSETS_PROJECT_KEY=xxx
   ```
6. **Configurar Webhook:** Settings > Integration & API Docs > URL: `https://martina-olvr.vercel.app/webhooks/finassets`
7. **Testar:** Clicar em Crypto → fazer pagamento de teste

## Credenciais Finassets (adicionar ao .env)
```
FINASSETS_API_KEY=
FINASSETS_SECRET_KEY=
FINASSETS_PROJECT_KEY=
```
