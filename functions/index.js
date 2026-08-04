const functions = require('firebase-functions');
const fetch = require('node-fetch');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

admin.initializeApp();
const db = admin.firestore();

const ASAAS_KEY = process.env.ASAAS_KEY || '';
const OPENAI_KEY = process.env.OPENAI_KEY || '';
const ASAAS_URL = 'https://sandbox.asaas.com/api/v3';

// ─── CONFIGURAÇÃO SMTP — lida do Firestore (config/smtp) ────────────────────
// A senha e demais dados são editados pela tela de Configurações do CRM e
// salvos em Firestore. Isso evita depender de functions.config() (que não
// propaga de forma confiável dependendo da geração das functions) ou de
// arquivos .env que precisam ser versionados manualmente.
async function getSmtpConfig() {
  try {
    const snap = await db.collection('config').doc('smtp').get();
    if (!snap.exists) {
      console.log('[email] config/smtp não existe no Firestore ainda');
      return null;
    }
    const d = snap.data();
    if (!d.host || !d.usuario || !d.senha) {
      console.log('[email] config/smtp incompleta — host/usuario/senha faltando');
      return null;
    }
    return {
      host: d.host,
      port: parseInt(d.porta || '465', 10),
      user: d.usuario,
      pass: d.senha,
    };
  } catch (err) {
    console.error('[email] erro ao buscar config/smtp:', err.message);
    return null;
  }
}

async function enviarEmail({ to, subject, html }) {
  if (!to) {
    console.log('[email] destinatário vazio, ignorando envio');
    return;
  }
  const cfg = await getSmtpConfig();
  if (!cfg) {
    throw new Error('Configuração de email não encontrada. Configure em Configurações > Email (SMTP) no CRM.');
  }
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  try {
    await transporter.sendMail({
      from: `"Secullum CRM" <${cfg.user}>`,
      to,
      subject,
      html,
    });
    console.log('[email] enviado com sucesso para:', to, '-', subject);
  } catch (err) {
    console.error('[email] erro ao enviar para', to, ':', err.message);
    throw err;
  }
}

const ALLOWED_ORIGINS = [
  'https://secullum-crm.vercel.app',
  'https://secullum-crm-appguion-lbru8i18s-andreuscalodiano-pngs-projects.vercel.app',
  'http://localhost:3000',
];

function setCors(req, res) {
  const origin = req.headers.origin || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.set('Access-Control-Allow-Origin', allowed);
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Max-Age', '3600');
}

// ─── ENVIO DE EMAIL — NOTIFICAÇÕES DE RESPONSÁVEL ────────────────────────────
exports.enviarEmailNotificacao = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const { to, subject, html } = req.body || {};
    if (!to || !subject || !html) {
      res.status(400).json({ error: 'Campos obrigatórios: to, subject, html' });
      return;
    }
    await enviarEmail({ to, subject, html });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('enviarEmailNotificacao error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PROXY ASAAS ──────────────────────────────────────────────────────────────
exports.asaasProxy = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const { path = '', method = 'GET', body = null } = req.body || {};
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json', 'access_token': ASAAS_KEY },
    };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);
    const resp = await fetch(`${ASAAS_URL}${path}`, opts);
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    console.error('asaasProxy error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PROXY OPENAI ──────────────────────────────────────────────────────────────
exports.openaiProxy = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const { system = '', messages = [], max_tokens = 800 } = req.body || {};

    // Suporta dois formatos:
    // 1. Formato simples: { system, messages: [{role, content: string}] }
    // 2. Formato multimodal: { messages: [{role, content: [{type, ...}]}] }
    let openaiMessages;
    if (system) {
      openaiMessages = [{ role: 'system', content: system }, ...messages];
    } else {
      openaiMessages = messages;
    }

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({ model: 'gpt-4o', max_tokens, messages: openaiMessages }),
    });
    const data = await resp.json();
    if (!resp.ok) { res.status(resp.status).json({ error: data?.error?.message || 'Erro OpenAI' }); return; }
    res.status(200).json({ text: data.choices?.[0]?.message?.content || '' });
  } catch (err) {
    console.error('openaiProxy error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PROXY CLAUDE (leitura de PDF/documentos) ────────────────────────────────
const CLAUDE_KEY = process.env.CLAUDE_KEY || '';

exports.claudeProxy = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const { messages = [], max_tokens = 1000 } = req.body || {};
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens,
        messages,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.error('claudeProxy error:', data);
      res.status(resp.status).json({ error: data?.error?.message || 'Erro Claude API' });
      return;
    }
    const text = data.content?.find(b => b.type === 'text')?.text || '';
    res.status(200).json({ text });
  } catch (err) {
    console.error('claudeProxy error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── WEBHOOK ASAAS ────────────────────────────────────────────────────────────
exports.asaasWebhook = functions.https.onRequest(async (req, res) => {
  // Responde 200 imediatamente para o Asaas nao reenviar
  res.status(200).send('OK');

  try {
    const event = req.body;
    const tipo = event?.event || '';
    const payment = event?.payment || {};
    const subscription = event?.subscription || {};

    console.log('[webhook] evento:', tipo);
    console.log('[webhook] payment.id:', payment.id);
    console.log('[webhook] payment.customer:', payment.customer);
    console.log('[webhook] payment.description:', payment.description);
    console.log('[webhook] subscription.customer:', subscription.customer);

    const statusMap = {
      'PAYMENT_RECEIVED':   'RECEIVED',
      'PAYMENT_CONFIRMED':  'RECEIVED',
      'PAYMENT_AUTHORIZED': 'RECEIVED',
      'PAYMENT_OVERDUE':    'OVERDUE',
      'PAYMENT_DELETED':    'CANCELED',
      'PAYMENT_REFUNDED':   'REFUNDED',
      'PAYMENT_CHARGEBACK': 'CHARGEBACK',
      'PAYMENT_PENDING':    'PENDING',
    };

    const novoStatus = statusMap[tipo];

    if (!novoStatus && !tipo.startsWith('SUBSCRIPTION_')) {
      console.log('[webhook] evento ignorado (nao mapeado):', tipo);
      return;
    }

    const customerIdRaw = payment.customer || subscription.customer || '';
    if (!customerIdRaw) {
      console.log('[webhook] sem customer ID, ignorando');
      return;
    }

    const customerIdNorm = customerIdRaw.toLowerCase().trim();
    console.log('[webhook] buscando cliente com asaas_id:', customerIdNorm);

    let clienteDoc = null;

    // Tentativa 1: match exato como veio do Asaas
    let snap = await db.collection('clientes')
      .where('asaas_id', '==', customerIdRaw)
      .limit(1).get();
    if (!snap.empty) {
      clienteDoc = snap.docs[0];
      console.log('[webhook] cliente encontrado (match exato):', clienteDoc.id);
    }

    // Tentativa 2: lowercase
    if (!clienteDoc) {
      snap = await db.collection('clientes')
        .where('asaas_id', '==', customerIdNorm)
        .limit(1).get();
      if (!snap.empty) {
        clienteDoc = snap.docs[0];
        console.log('[webhook] cliente encontrado (lowercase):', clienteDoc.id);
      }
    }

    // Tentativa 3: uppercase
    if (!clienteDoc) {
      snap = await db.collection('clientes')
        .where('asaas_id', '==', customerIdRaw.toUpperCase())
        .limit(1).get();
      if (!snap.empty) {
        clienteDoc = snap.docs[0];
        console.log('[webhook] cliente encontrado (uppercase):', clienteDoc.id);
      }
    }

    // FIX PRINCIPAL: Fallback — busca TODOS os clientes e compara manualmente.
    // Resolve quando o indice do Firestore para "asaas_id != ''" nao esta criado
    // ou quando ha inconsistencia de case no valor salvo.
    if (!clienteDoc) {
      console.log('[webhook] tentando busca fallback em todos os clientes...');
      const allSnap = await db.collection('clientes').get();
      for (const docItem of allSnap.docs) {
        const savedId = (docItem.data().asaas_id || '').toLowerCase().trim();
        if (savedId && savedId === customerIdNorm) {
          clienteDoc = docItem;
          console.log('[webhook] cliente encontrado (fallback completo):', clienteDoc.id);
          break;
        }
      }
    }

    if (!clienteDoc) {
      console.error('[webhook] cliente NAO encontrado para customer:', customerIdRaw);
      // Salva log de falha para diagnostico no Firestore
      await db.collection('webhook_falhas').add({
        customerIdRaw,
        tipo,
        paymentId: payment.id || '',
        desc: payment.description || '',
        data: new Date().toISOString(),
        motivo: 'cliente_nao_encontrado',
      });
      return;
    }

    const clienteData = clienteDoc.data();
    const update = { atualizadoEm: new Date().toISOString() };
    const desc = (payment.description || '').toLowerCase();
    const paymentId = payment.id || '';

    console.log('[webhook] cliente:', clienteData.nome);
    console.log('[webhook] asaas_link_impl_id salvo:', clienteData.asaas_link_impl_id);
    console.log('[webhook] asaas_link_equip_id salvo:', clienteData.asaas_link_equip_id);
    console.log('[webhook] asaas_subscription_id salvo:', clienteData.asaas_subscription_id);

    // Identificacao por payment_id (mais confiavel) ou por descricao
    const isImpl =
      (paymentId && clienteData.asaas_link_impl_id && clienteData.asaas_link_impl_id === paymentId) ||
      desc.includes('implanta');

    const isEquip =
      (paymentId && clienteData.asaas_link_equip_id && clienteData.asaas_link_equip_id === paymentId) ||
      desc.includes('equip');

    const isSistema =
      tipo.startsWith('SUBSCRIPTION_') ||
      (clienteData.asaas_subscription_id && payment.subscription === clienteData.asaas_subscription_id) ||
      desc.includes('sistema') ||
      desc.includes('mensalidade') ||
      desc.includes('saas');

    console.log(`[webhook] isImpl=${isImpl} isEquip=${isEquip} isSistema=${isSistema} novoStatus=${novoStatus}`);

    // Prioridade: impl > equip > sistema > generico
    if (isImpl && !isSistema) {
      update.asaas_status_impl = novoStatus;
      console.log('[webhook] -> asaas_status_impl =', novoStatus);
      if (novoStatus === 'RECEIVED') {
        const equipOk = clienteData.asaas_status_equip === 'RECEIVED' || !clienteData.asaas_link_equip_id;
        update.status = equipOk ? 'Faturado' : 'Faturado parcial';
      }
      if (novoStatus === 'OVERDUE') update.status = 'Inadimplente';

    } else if (isEquip && !isSistema) {
      update.asaas_status_equip = novoStatus;
      console.log('[webhook] -> asaas_status_equip =', novoStatus);
      if (novoStatus === 'RECEIVED') {
        const implOk = clienteData.asaas_status_impl === 'RECEIVED' || !clienteData.asaas_link_impl_id;
        update.status = implOk ? 'Faturado' : 'Faturado parcial';
      }
      if (novoStatus === 'OVERDUE') update.status = 'Inadimplente';

    } else if (isSistema) {
      if (tipo === 'SUBSCRIPTION_DELETED' || tipo === 'SUBSCRIPTION_EXPIRED') {
        update.asaas_status_sistema = 'CANCELED';
        update.asaas_status = 'CANCELED';
        update.status = 'Cancelado';
      } else if (novoStatus) {
        update.asaas_status_sistema = novoStatus;
        update.asaas_status = novoStatus;
        if (novoStatus === 'RECEIVED') {
          update.asaas_ultimo_pagamento = new Date().toISOString();
          update.status = 'Faturado';
        }
        if (novoStatus === 'OVERDUE') update.status = 'Inadimplente';
      }

    } else {
      // Generico
      update.asaas_status = novoStatus;
      console.log('[webhook] -> asaas_status generico =', novoStatus);
      if (novoStatus === 'RECEIVED') update.status = 'Faturado';
      if (novoStatus === 'OVERDUE') update.status = 'Inadimplente';
    }

    console.log('[webhook] salvando update:', JSON.stringify(update));
    await clienteDoc.ref.update(update);
    console.log('[webhook] cliente atualizado com sucesso:', clienteDoc.id);

    // Historico
    await db.collection('historico_cliente').add({
      clienteId: clienteDoc.id,
      clienteNome: clienteData.nome || '',
      tipo: 'webhook_asaas',
      descricao: `${tipo} — Status: ${novoStatus || tipo} | Payment: ${paymentId}`,
      data: new Date().toISOString(),
      usuario: 'Asaas Webhook',
    });

  } catch (err) {
    console.error('[webhook] ERRO:', err.message, err.stack);
    try {
      await db.collection('webhook_erros').add({
        erro: err.message,
        stack: err.stack,
        body: JSON.stringify(req.body || {}),
        data: new Date().toISOString(),
      });
    } catch (_) {}
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// META LEADS — Webhook Facebook/Instagram Lead Ads
// URL: https://us-central1-secullum-crm.cloudfunctions.net/metaLeads
// Verify Token (configurar no Meta for Developers): GUION_LEADS_2024
// Token de página: firebase functions:config:set meta.page_token="SEU_TOKEN"
//   ou variável de ambiente META_PAGE_TOKEN
// Deploy: firebase deploy --only functions:metaLeads
// ═══════════════════════════════════════════════════════════════════════════

const META_VERIFY_TOKEN = 'GUION_LEADS_2024';
const META_API_VERSION = 'v19.0';

// Mapeia os nomes internos dos campos do formulário Meta → campos do CRM.
// Os nomes internos de campos customizados são gerados pela Meta (minúsculo,
// underscores). Confira o nome real em Meta Business Suite > Formulários.
function mapearCamposMeta(fieldData) {
  const mapa = {
    'full_name': 'nome',
    'email': 'email',
    'phone_number': 'telefone',
    'quantos_funcionarios_sua_empresa_possui': 'funcionarios',
    'quantos_funcionários_sua_empresa_possui?': 'funcionarios',
    'hoje_sua_empresa_ja_utiliza_algum_sistema_de_controle_de_ponto': 'sistema_ponto',
    'hoje_sua_empresa_já_utiliza_algum_sistema_de_controle_de_ponto?': 'sistema_ponto',
    'qual_solucao_voce_procura': 'solucao',
    'qual_solução_você_procura?': 'solucao',
  };
  const out = {};
  (fieldData || []).forEach(({ name, values }) => {
    const key = mapa[name] || name;
    out[key] = (values && values[0]) || '';
  });
  return out;
}

exports.metaLeads = functions.https.onRequest(async (req, res) => {

  // ── GET: verificação do webhook pela Meta ─────────────────────────────────
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
      console.log('[metaLeads] webhook verificado com sucesso');
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Token inválido');
  }

  // ── POST: recebimento de leads ────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const body = req.body;
      if (body.object !== 'page') return res.status(200).send('OK');

      const pageToken =
        (functions.config().meta && functions.config().meta.page_token) ||
        process.env.META_PAGE_TOKEN || '';

      for (const entry of (body.entry || [])) {
        for (const change of (entry.changes || [])) {
          if (change.field !== 'leadgen') continue;

          const v = change.value || {};
          const leadId = v.leadgen_id;
          if (!leadId) continue;

          // Buscar dados completos do lead na Graph API
          let campos = {};
          let criadoEm = new Date().toISOString();
          if (pageToken) {
            try {
              const resp = await fetch(
                `https://graph.facebook.com/${META_API_VERSION}/${leadId}?fields=field_data,created_time&access_token=${pageToken}`
              );
              const data = await resp.json();
              if (data.error) {
                console.error('[metaLeads] Graph API erro:', JSON.stringify(data.error));
              } else {
                campos = mapearCamposMeta(data.field_data);
                if (data.created_time) criadoEm = new Date(data.created_time).toISOString();
              }
            } catch (apiErr) {
              console.error('[metaLeads] erro Graph API:', apiErr.message);
            }
          } else {
            console.log('[metaLeads] AVISO: meta.page_token não configurado — lead salvo sem dados do formulário');
          }

          const leadDoc = {
            ...campos,
            status: 'novo',
            origem: 'Meta Ads',
            campanha: v.campaign_name || v.campaign_id || '',
            formulario: v.form_name || v.form_id || '',
            anuncio: v.ad_name || v.ad_id || '',
            pageId: entry.id || '',
            leadgenId: leadId,
            criadoEm,
            atualizadoEm: new Date().toISOString(),
          };

          await db.collection('leads').doc(String(leadId)).set(leadDoc, { merge: true });
          console.log('[metaLeads] lead salvo:', leadId, campos.nome || '(sem nome)');
        }
      }

      return res.status(200).send('OK');
    } catch (err) {
      console.error('[metaLeads] ERRO:', err.message, err.stack);
      // Sempre responder 200 para a Meta não desativar o webhook
      return res.status(200).send('OK');
    }
  }

  return res.status(405).send('Método não permitido');
});


// ═══════════════════════════════════════════════════════════════════════════
// SYNC LEADS — Google Sheets → Firestore (roda a cada 5 minutos)
//
// A Meta escreve os leads na planilha automaticamente (integração nativa
// Formulários de lead → Google Sheets). Esta função lê a planilha e grava
// na coleção 'leads'. Funciona com o CRM fechado, pois roda no servidor.
//
// CONFIGURAR (escolha UMA das opções):
//
//  Opção A — planilha publicada como CSV (mais simples):
//    Na planilha: Arquivo > Compartilhar > Publicar na web > aba > CSV
//    firebase functions:config:set sheets.csv_url="URL_PUBLICADA"
//
//  Opção B — planilha privada via Service Account:
//    firebase functions:config:set sheets.id="ID_DA_PLANILHA" \
//      sheets.email="conta@projeto.iam.gserviceaccount.com" \
//      sheets.key="-----BEGIN PRIVATE KEY-----\n..."
//    Compartilhe a planilha com o e-mail da service account (leitor).
//    Requer: cd functions && npm install googleapis
//
// Deploy: firebase deploy --only functions:syncLeadsSheets
// ═══════════════════════════════════════════════════════════════════════════

// Detecta o delimitador da primeira linha (a Meta exporta com TAB)
function detectarDelim(texto) {
  const primeira = (texto.split(/\r?\n/)[0] || '');
  const cont = { '\t': 0, ';': 0, ',': 0 };
  let aspas = false;
  for (const ch of primeira) {
    if (ch === '"') { aspas = !aspas; continue; }
    if (!aspas && cont[ch] !== undefined) cont[ch]++;
  }
  let melhor = ',', max = 0;
  for (const [d, n] of Object.entries(cont)) if (n > max) { max = n; melhor = d; }
  return max > 0 ? melhor : ',';
}

function parseCSV(texto, delim) {
  const linhas = []; let campo = ''; let linha = []; let aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i], prox = texto[i + 1];
    if (aspas) {
      if (ch === '"' && prox === '"') { campo += '"'; i++; }
      else if (ch === '"') aspas = false;
      else campo += ch;
    } else {
      if (ch === '"') aspas = true;
      else if (ch === delim) { linha.push(campo); campo = ''; }
      else if (ch === '\n') { linha.push(campo); campo = ''; linhas.push(linha); linha = []; }
      else if (ch === '\r') { /* ignora */ }
      else campo += ch;
    }
  }
  if (campo !== '' || linha.length > 0) { linha.push(campo); linhas.push(linha); }
  return linhas.filter(l => l.some(x => (x || '').trim() !== ''));
}

// Remove prefixos que a Meta adiciona (p:, l:, ag:, as:, c:, f:) e aspas
function limparValor(v) {
  let s = (v || '').trim();
  s = s.replace(/^"(.*)"$/s, '$1');
  s = s.replace(/^(p|l|ag|as|c|f):/, '');
  return s.trim();
}
function humanizarValor(v) {
  let s = limparValor(v);
  if (!s) return '';
  s = s.replace(/_/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function normalizarCabecalho(h) {
  return (h || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z_]/g, '');
}

// Encontra o indice da coluna pelo nome (match exato, depois parcial)
function acharCol(head, nomes) {
  for (const n of nomes) {
    const i = head.findIndex(h => normalizarCabecalho(h) === normalizarCabecalho(n));
    if (i >= 0) return i;
  }
  for (const n of nomes) {
    const i = head.findIndex(h => normalizarCabecalho(h).includes(normalizarCabecalho(n)));
    if (i >= 0) return i;
  }
  return -1;
}

function normalizarUrlPlanilha(u){
  let url = (u || '').trim();
  if (!url) return '';
  if (/\/pubhtml/.test(url)) return url.replace(/\/pubhtml.*$/, '/pub?output=csv');
  if (/\/pub(\?|$)/.test(url) && !/output=csv/.test(url)) {
    return url + (url.includes('?') ? '&' : '?') + 'output=csv';
  }
  return url;
}

// Baixa e converte uma planilha publicada em CSV
async function baixarPlanilha(url) {
  const alvo = normalizarUrlPlanilha(url);
  const resp = await fetch(alvo, { redirect: 'follow' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const texto = await resp.text();
  if (/^\s*</.test(texto)) {
    throw new Error('A planilha respondeu HTML em vez de CSV. Republique escolhendo o formato CSV.');
  }
  return parseCSV(texto, detectarDelim(texto));
}

// Lista as planilhas cadastradas em Configurações > Planilhas de leads.
// Mantém compatibilidade com a config antiga (sheets.csv_url).
async function listarPlanilhas() {
  const lista = [];
  const snap = await db.collection('config_planilhas').get();
  snap.forEach(d => {
    const p = d.data();
    if (p.ativo !== false && p.url) lista.push({ id: d.id, nome: p.nome || d.id, url: p.url });
  });
  if (lista.length === 0) {
    const cfg = (functions.config().sheets || {});
    const legado = cfg.csv_url || process.env.SHEETS_CSV_URL;
    if (legado) lista.push({ id: null, nome: 'Planilha padrão', url: legado });
  }
  return lista;
}

// Importa as linhas de uma planilha já baixada
async function importarLinhas(dados, origemNome) {
  if (dados.length < 2) return { novos: 0, pulados: 0, total: 0 };

  const head = dados[0].map(h => (h || '').trim());
  const col = {
    id:           acharCol(head, ['id']),
    criadoEm:     acharCol(head, ['created_time', 'created', 'data']),
    nome:         acharCol(head, ['full_name', 'nome_completo', 'nome', 'name']),
    email:        acharCol(head, ['email']),
    telefone:     acharCol(head, ['phone_number', 'telefone', 'phone']),
    funcionarios: acharCol(head, ['funcionarios', 'employees']),
    sistemaPonto: acharCol(head, ['controle_de_ponto', 'sistema']),
    solucao:      acharCol(head, ['solucao']),
    campanha:     acharCol(head, ['campaign_name']),
    conjunto:     acharCol(head, ['adset_name']),
    anuncio:      acharCol(head, ['ad_name']),
    formulario:   acharCol(head, ['form_name']),
    plataforma:   acharCol(head, ['platform']),
  };

  const snap = await db.collection('leads').get();
  const existentes = new Set(), emails = new Set(), tels = new Set();
  snap.forEach(d => {
    const x = d.data();
    if (x.leadgenId) existentes.add(String(x.leadgenId));
    if (x.email) emails.add(String(x.email).toLowerCase().trim());
    if (x.telefone) tels.add(String(x.telefone).replace(/\D/g, ''));
  });

  const val  = (l, i) => (i >= 0 ? limparValor(l[i]) : '');
  const valH = (l, i) => (i >= 0 ? humanizarValor(l[i]) : '');

  let novos = 0, pulados = 0;
  const batch = db.batch();

  for (const linha of dados.slice(1)) {
    const leadId = val(linha, col.id);
    const email = val(linha, col.email).toLowerCase();
    const telRaw = val(linha, col.telefone);
    const telNum = telRaw.replace(/\D/g, '');

    if ((leadId && existentes.has(leadId)) ||
        (email && emails.has(email)) ||
        (telNum && tels.has(telNum))) { pulados++; continue; }

    const nome = val(linha, col.nome);
    if (!nome && !email && !telRaw) continue;

    let criadoEm = new Date().toISOString();
    const dataRaw = val(linha, col.criadoEm);
    if (dataRaw) {
      const d = new Date(dataRaw);
      if (!isNaN(d.getTime())) criadoEm = d.toISOString();
    }

    const plat = val(linha, col.plataforma).toLowerCase();
    const docId = leadId ? 'lead_meta_' + leadId
                         : 'lead_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

    batch.set(db.collection('leads').doc(docId), {
      nome: nome.toUpperCase(),
      email,
      telefone: telRaw,
      funcionarios: valH(linha, col.funcionarios),
      sistema_ponto: valH(linha, col.sistemaPonto),
      solucao: valH(linha, col.solucao),
      campanha: val(linha, col.campanha),
      conjunto: val(linha, col.conjunto),
      anuncio: val(linha, col.anuncio),
      formulario: val(linha, col.formulario),
      plataforma: plat === 'ig' ? 'Instagram' : plat === 'fb' ? 'Facebook' : humanizarValor(plat),
      origem: 'Meta Ads',
      status: 'novo',
      leadgenId: leadId || '',
      planilhaOrigem: origemNome || '',
      criadoEm,
      atualizadoEm: new Date().toISOString(),
      importadoPor: 'Sync automático',
      historico: [],
    }, { merge: true });

    if (leadId) existentes.add(leadId);
    if (email) emails.add(email);
    if (telNum) tels.add(telNum);
    novos++;
  }

  if (novos > 0) await batch.commit();
  return { novos, pulados, total: dados.length - 1 };
}

// Varre todas as planilhas cadastradas
async function sincronizarLeads() {
  const planilhas = await listarPlanilhas();
  if (planilhas.length === 0) {
    console.log('[syncLeads] nenhuma planilha cadastrada');
    return { novos: 0, existentes: 0, planilhas: 0, detalhes: [] };
  }

  let novosTotal = 0, puladosTotal = 0;
  const detalhes = [];

  for (const p of planilhas) {
    const agora = new Date().toISOString();
    try {
      const dados = await baixarPlanilha(p.url);
      const r = await importarLinhas(dados, p.nome);
      novosTotal += r.novos;
      puladosTotal += r.pulados;
      detalhes.push({ planilha: p.nome, novos: r.novos, total: r.total });
      console.log(`[syncLeads] "${p.nome}": ${r.novos} novo(s) de ${r.total} linha(s)`);
      if (p.id) {
        await db.collection('config_planilhas').doc(p.id).set({
          ultimaSync: agora, ultimoTotal: r.total, ultimosNovos: r.novos, ultimoErro: null,
        }, { merge: true });
      }
    } catch (err) {
      console.error(`[syncLeads] erro em "${p.nome}":`, err.message);
      detalhes.push({ planilha: p.nome, erro: err.message });
      if (p.id) {
        await db.collection('config_planilhas').doc(p.id).set({
          ultimaSync: agora, ultimoErro: err.message,
        }, { merge: true });
      }
    }
  }

  return { novos: novosTotal, existentes: puladosTotal, planilhas: planilhas.length, detalhes };
}

// Execução agendada — a cada 5 minutos
exports.syncLeadsSheets = functions.pubsub
  .schedule('every 5 minutes')
  .timeZone('America/Sao_Paulo')
  .onRun(async () => {
    try {
      const r = await sincronizarLeads();
      await db.collection('sync_log').add({
        tipo: 'leads_sheets',
        novos: r.novos,
        existentes: r.existentes,
        planilhas: r.planilhas,
        detalhes: r.detalhes || [],
        data: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[syncLeads] ERRO:', err.message);
      await db.collection('sync_log').add({
        tipo: 'leads_sheets',
        erro: err.message,
        data: new Date().toISOString(),
      });
    }
    return null;
  });

// Execução manual — botão "Sincronizar agora" no CRM
exports.syncLeadsManual = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const r = await sincronizarLeads();
    res.status(200).json({ ok: true, ...r });
  } catch (err) {
    console.error('[syncLeadsManual] ERRO:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DATAFY — API oficial do WhatsApp
// Base: https://cloud.datafyapi.com.br   Auth: Bearer sk_live_xxx
//
// O token fica no Firestore (config_whatsapp/{id}), nunca no navegador.
// O front chama esta function informando apenas o ID do número cadastrado.
// Deploy: firebase deploy --only functions:datafyProxy,functions:datafyEnviar
// ═══════════════════════════════════════════════════════════════════════════

const DATAFY_URL = 'https://cloud.datafyapi.com.br';

// Busca o número cadastrado. Sem id, usa o marcado como padrão;
// com finalidade, usa o primeiro ativo daquela finalidade.
async function obterNumeroDatafy({ numeroId, finalidade }) {
  const snap = await db.collection('config_whatsapp').get();
  const nums = [];
  snap.forEach(d => nums.push({ id: d.id, ...d.data() }));
  const ativos = nums.filter(n => n.ativo !== false && n.token);

  if (numeroId) {
    const achado = nums.find(n => n.id === numeroId);
    if (!achado) throw new Error('Número do WhatsApp não encontrado: ' + numeroId);
    if (!achado.token) throw new Error(`O número "${achado.nome || numeroId}" está sem token.`);
    return achado;
  }
  if (finalidade) {
    const porFim = ativos.find(n => (n.finalidade || '').toLowerCase() === String(finalidade).toLowerCase());
    if (porFim) return porFim;
  }
  const padrao = ativos.find(n => n.padrao);
  if (padrao) return padrao;
  if (ativos.length) return ativos[0];
  throw new Error('Nenhum número de WhatsApp configurado. Cadastre em Configurações > Integrações.');
}

async function chamarDatafy({ token, path, method = 'GET', body = null }) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const resp = await fetch(`${DATAFY_URL}${path}`, opts);
  const texto = await resp.text();
  let data;
  try { data = texto ? JSON.parse(texto) : {}; } catch (_) { data = { raw: texto }; }
  return { status: resp.status, ok: resp.ok, data };
}

// Proxy genérico — usado pelo botão "Testar conexão" e consultas do painel
exports.datafyProxy = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const { numeroId, finalidade, path = '/me', method = 'GET', body = null, token = null } = req.body || {};
    // token avulso permite testar antes de salvar o cadastro
    const usar = token || (await obterNumeroDatafy({ numeroId, finalidade })).token;
    const r = await chamarDatafy({ token: usar, path, method, body });
    res.status(r.ok ? 200 : r.status).json(r.data);
  } catch (err) {
    console.error('[datafy] proxy erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Envio de mensagem com registro do resultado
exports.datafyEnviar = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const {
      numeroId, finalidade, para, texto,
      template = null, variaveis = null, idioma = 'pt_BR',
      contexto = '',
    } = req.body || {};

    if (!para) throw new Error('Informe o número do destinatário.');
    if (!texto && !template) throw new Error('Informe o texto ou o template da mensagem.');

    const numero = await obterNumeroDatafy({ numeroId, finalidade });

    // Normaliza o destinatário: só dígitos, com DDI do Brasil
    let destino = String(para).replace(/\D/g, '');
    if (!destino.startsWith('55') || destino.length < 12) {
      destino = '55' + destino.replace(/^0+/, '');
    }

    const path = template ? '/messages/send/template' : '/messages/send/text';
    const body = template
      ? { to: destino, template, language: idioma, ...(variaveis ? { body: variaveis } : {}) }
      : { to: destino, text: texto };

    const r = await chamarDatafy({ token: numero.token, path, method: 'POST', body });

    // Log de envio para auditoria
    await db.collection('whatsapp_log').add({
      numeroId: numero.id,
      numeroNome: numero.nome || '',
      finalidade: numero.finalidade || '',
      destino,
      tipo: template ? 'template' : 'texto',
      template: template || '',
      texto: texto || '',
      contexto,
      sucesso: r.ok,
      resposta: r.ok ? (r.data?.messages?.[0]?.id || 'ok') : JSON.stringify(r.data).slice(0, 500),
      data: new Date().toISOString(),
    });

    if (!r.ok) {
      const msg = r.data?.error?.message || r.data?.message || 'Falha ao enviar';
      res.status(r.status).json({ error: msg, detalhe: r.data });
      return;
    }
    res.status(200).json({ ok: true, ...r.data });
  } catch (err) {
    console.error('[datafy] envio erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MOTOR DE GATILHOS — automações por evento e por horário
//
// Os gatilhos ficam na coleção 'gatilhos'. Cada um define:
//   evento      cliente_criado | cliente_status | solicitacao_criada |
//               lead_criado | implantacao_etapa | orcamento_fechado | agendado
//   condicoes   [{campo, operador, valor}]
//   destino     {tipo:'usuario'|'responsavel'|'numero'|'cliente', valor}
//   mensagem    texto com {{variaveis}}
//   relatorio   (só para agendados) qual lista enviar
//
// Como usa Firestore triggers, dispara mesmo com o CRM fechado — inclusive
// quando o registro vem do sync de leads ou do webhook do Asaas.
// ═══════════════════════════════════════════════════════════════════════════

function fmtMoedaBR(v) {
  const n = Number(v) || 0;
  return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDataBR(v) {
  if (!v) return '';
  const d = new Date(String(v).length <= 10 ? v + 'T12:00:00' : v);
  return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('pt-BR');
}

// Monta as variáveis disponíveis conforme o evento
function montarVariaveis(evento, dados, extra = {}) {
  const c = dados || {};
  const base = {
    data: new Date().toLocaleDateString('pt-BR'),
    hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    ...extra,
  };
  if (evento.startsWith('cliente') || evento === 'orcamento_fechado') {
    return {
      ...base,
      cliente: c.nome || '', empresa: c.empresa || c.nome || '',
      cnpj: c.cnpj || '', contato: c.contato || '',
      telefone: c.tel || '', email: c.email || '',
      cidade: c.cidade || '', uf: c.uf || '',
      plano: c.plano || '', vendedor: c.vendedor || '',
      status: c.status || '', funcionarios: String(c.func || ''),
      equipamento: c.equipTipo || '',
      valor_sistema: fmtMoedaBR(c.vS), valor_implantacao: fmtMoedaBR(c.vI),
      valor_equipamento: fmtMoedaBR(c.vE), total: fmtMoedaBR(c.total),
    };
  }
  if (evento === 'solicitacao_criada') {
    return {
      ...base,
      titulo: c.titulo || '', cliente: c.clienteNome || '',
      categoria: c.categoria || '', prioridade: c.prioridade || '',
      descricao: (c.descricao || '').slice(0, 300),
      responsavel: c.responsavelNome || '', aberta_por: c.criadoPor || '',
    };
  }
  if (evento === 'lead_criado') {
    return {
      ...base,
      lead: c.nome || '', telefone: c.telefone || '', email: c.email || '',
      origem: c.origem || '', campanha: c.campanha || '',
      solucao: c.solucao || '', funcionarios: c.funcionarios || '',
      plataforma: c.plataforma || '',
    };
  }
  if (evento === 'implantacao_etapa') {
    return {
      ...base,
      cliente: extra.clienteNome || '', etapa: extra.etapaNova || '',
      etapa_anterior: extra.etapaAntiga || '',
      responsavel: c.responsavel || '', prazo: fmtDataBR(c.prazo),
    };
  }
  return base;
}

function aplicarVariaveis(texto, vars) {
  return String(texto || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) =>
    vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''
  );
}

// Avalia as condições do gatilho contra os dados do registro
function condicoesOk(condicoes, dados, extra = {}) {
  if (!Array.isArray(condicoes) || condicoes.length === 0) return true;
  const fonte = { ...dados, ...extra };
  return condicoes.every(c => {
    const atual = String(fonte[c.campo] ?? '').toLowerCase().trim();
    const esperado = String(c.valor ?? '').toLowerCase().trim();
    const numA = parseFloat(String(fonte[c.campo]).replace(',', '.'));
    const numE = parseFloat(String(c.valor).replace(',', '.'));
    switch (c.operador) {
      case 'igual':     return atual === esperado;
      case 'diferente': return atual !== esperado;
      case 'contem':    return atual.includes(esperado);
      case 'maior':     return !isNaN(numA) && !isNaN(numE) && numA > numE;
      case 'menor':     return !isNaN(numA) && !isNaN(numE) && numA < numE;
      case 'preenchido':return atual !== '';
      case 'vazio':     return atual === '';
      default:          return true;
    }
  });
}

// Resolve para quem enviar. Retorna [{nome, numero}]
async function resolverDestinos(destino, dados, extra = {}) {
  const out = [];
  if (!destino) return out;
  const tipo = destino.tipo || 'usuario';

  if (tipo === 'numero') {
    // Aceita um número ou uma lista
    const lista = Array.isArray(destino.valor) ? destino.valor : (destino.valor ? [destino.valor] : []);
    lista.filter(n => String(n).trim()).forEach((n, i) =>
      out.push({ nome: `Número avulso ${lista.length > 1 ? i + 1 : ''}`.trim(), numero: n })
    );
    return out;
  }
  if (tipo === 'cliente') {
    // Preparado para uso futuro — só dispara se o gatilho pedir explicitamente
    const tel = dados?.tel || dados?.telefone || '';
    if (tel) out.push({ nome: dados?.nome || 'Cliente', numero: tel });
    return out;
  }

  const snap = await db.collection('usuarios').get();
  const usuarios = [];
  snap.forEach(d => usuarios.push({ id: d.id, ...d.data() }));
  const ativos = usuarios.filter(u => u.status !== 'revogado' && u.celular);

  if (tipo === 'usuario') {
    const ids = Array.isArray(destino.valor) ? destino.valor : [destino.valor];
    ids.forEach(id => {
      const u = ativos.find(x => x.id === id);
      if (u) out.push({ nome: u.nome || u.email, numero: u.celular });
    });
    return out;
  }
  if (tipo === 'responsavel') {
    // Vendedor do cliente, responsável da solicitação ou da implantação
    const nomeResp = extra.responsavelNome || dados?.responsavelNome || dados?.vendedor || dados?.responsavel || '';
    const u = ativos.find(x =>
      (x.nome || '').toLowerCase().trim() === String(nomeResp).toLowerCase().trim()
    ) || ativos.find(x => x.id === (dados?.responsavelId || ''));
    if (u) out.push({ nome: u.nome || u.email, numero: u.celular });
    return out;
  }
  if (tipo === 'todos') {
    ativos.forEach(u => out.push({ nome: u.nome || u.email, numero: u.celular }));
    return out;
  }
  return out;
}

// Executa todos os gatilhos ativos de um evento
async function processarGatilhos(evento, dados, extra = {}) {
  try {
    const snap = await db.collection('gatilhos').get();
    const gatilhos = [];
    snap.forEach(d => gatilhos.push({ id: d.id, ...d.data() }));
    const aplicaveis = gatilhos.filter(g => g.ativo !== false && g.evento === evento);
    if (!aplicaveis.length) return;

    for (const g of aplicaveis) {
      try {
        if (!condicoesOk(g.condicoes, dados, extra)) {
          console.log(`[gatilho] "${g.nome}" ignorado — condições não atendidas`);
          continue;
        }
        const vars = montarVariaveis(evento, dados, extra);
        const textoFixo = aplicarVariaveis(g.mensagem, vars);
        const destinos = await resolverDestinos(g.destino, dados, extra);

        if (!destinos.length) {
          console.log(`[gatilho] "${g.nome}" sem destinatário válido`);
          await db.collection('gatilhos_log').add({
            gatilhoId: g.id, gatilhoNome: g.nome, evento,
            sucesso: false, erro: 'Nenhum destinatário com celular cadastrado',
            data: new Date().toISOString(),
          });
          continue;
        }

        for (const d of destinos) {
          // Com IA ligada, cada pessoa recebe uma redação própria
          const texto = g.usarIA
            ? await gerarMensagemIA({
                instrucao: aplicarVariaveis(g.instrucaoIA || g.mensagem, vars),
                dados: vars,
                destinatario: (d.nome || '').split(' ')[0],
                textoFallback: textoFixo,
              })
            : textoFixo;

          const numero = await obterNumeroDatafy({
            numeroId: g.numeroId || null,
            finalidade: g.finalidade || 'interno',
          });
          let destinoNum = String(d.numero).replace(/\D/g, '');
          if (!destinoNum.startsWith('55') || destinoNum.length < 12) {
            destinoNum = '55' + destinoNum.replace(/^0+/, '');
          }
          const r = await chamarDatafy({
            token: numero.token,
            path: '/messages/send/text',
            method: 'POST',
            body: { to: destinoNum, text: texto },
          });
          await db.collection('gatilhos_log').add({
            gatilhoId: g.id, gatilhoNome: g.nome, evento,
            destinatario: d.nome, destino: destinoNum,
            mensagem: texto.slice(0, 500),
            comIA: !!g.usarIA,
            sucesso: r.ok,
            erro: r.ok ? '' : JSON.stringify(r.data).slice(0, 300),
            data: new Date().toISOString(),
          });
          console.log(`[gatilho] "${g.nome}" -> ${d.nome}: ${r.ok ? 'enviado' : 'falhou'}`);
        }
        await db.collection('gatilhos').doc(g.id).set({
          ultimoDisparo: new Date().toISOString(),
          totalDisparos: (g.totalDisparos || 0) + 1,
        }, { merge: true });
      } catch (errG) {
        console.error(`[gatilho] erro em "${g.nome}":`, errG.message);
        await db.collection('gatilhos_log').add({
          gatilhoId: g.id, gatilhoNome: g.nome, evento,
          sucesso: false, erro: errG.message, data: new Date().toISOString(),
        });
      }
    }
  } catch (err) {
    console.error('[gatilho] erro geral:', err.message);
  }
}

// ─── TRIGGERS DO FIRESTORE ───────────────────────────────────────────────────

exports.gatilhoClienteCriado = functions.firestore
  .document('clientes/{id}')
  .onCreate(async snap => {
    await processarGatilhos('cliente_criado', { id: snap.id, ...snap.data() });
    return null;
  });

exports.gatilhoClienteAtualizado = functions.firestore
  .document('clientes/{id}')
  .onUpdate(async change => {
    const antes = change.before.data() || {};
    const depois = change.after.data() || {};
    if (antes.status !== depois.status) {
      await processarGatilhos('cliente_status',
        { id: change.after.id, ...depois },
        { status_anterior: antes.status || '', status_novo: depois.status || '' });
    }
    return null;
  });

exports.gatilhoSolicitacaoCriada = functions.firestore
  .document('solicitacoes/{id}')
  .onCreate(async snap => {
    await processarGatilhos('solicitacao_criada', { id: snap.id, ...snap.data() });
    return null;
  });

exports.gatilhoLeadCriado = functions.firestore
  .document('leads/{id}')
  .onCreate(async snap => {
    await processarGatilhos('lead_criado', { id: snap.id, ...snap.data() });
    return null;
  });

exports.gatilhoImplantacaoEtapa = functions.firestore
  .document('implantacoes/{id}')
  .onUpdate(async (change, context) => {
    const antes = change.before.data() || {};
    const depois = change.after.data() || {};
    if (antes.etapa === depois.etapa) return null;
    // Busca o nome do cliente para usar na mensagem
    let clienteNome = '';
    try {
      const cli = await db.collection('clientes').doc(context.params.id).get();
      if (cli.exists) clienteNome = cli.data().nome || '';
    } catch (_) {}
    await processarGatilhos('implantacao_etapa', depois, {
      clienteNome,
      etapaAntiga: antes.etapa || '',
      etapaNova: depois.etapa || '',
    });
    return null;
  });

exports.gatilhoOrcamentoFechado = functions.firestore
  .document('orcamentos/{id}')
  .onUpdate(async change => {
    const antes = change.before.data() || {};
    const depois = change.after.data() || {};
    if (antes.status === depois.status || depois.status !== 'fechado') return null;
    const c = depois.cliente || {};
    await processarGatilhos('orcamento_fechado', {
      nome: c.empresa || c.nome || '', contato: c.nome || '',
      tel: c.tel || '', email: c.email || '',
      total: depois.subtotal || 0, vendedor: depois.detalhes?.vendedor || '',
    });
    return null;
  });

// ─── GATILHOS AGENDADOS (relatórios) ─────────────────────────────────────────

async function montarRelatorio(tipo) {
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const [cliSnap, implSnap, leadSnap] = await Promise.all([
    db.collection('clientes').get(),
    db.collection('implantacoes').get(),
    db.collection('leads').get(),
  ]);
  const clientes = []; cliSnap.forEach(d => clientes.push({ id: d.id, ...d.data() }));
  const impl = {}; implSnap.forEach(d => { impl[d.id] = d.data(); });
  const leads = []; leadSnap.forEach(d => leads.push({ id: d.id, ...d.data() }));

  if (tipo === 'implantacoes_atrasadas') {
    const lista = clientes.filter(c => {
      const i = impl[c.id] || {};
      return i.etapa !== 'processo_finalizado' && i.prazo && new Date(i.prazo + 'T12:00:00') < hoje;
    });
    if (!lista.length) return null;
    return `⚠️ *Implantações atrasadas* (${lista.length})\n\n` +
      lista.slice(0, 20).map(c => {
        const i = impl[c.id] || {};
        const dias = Math.floor((hoje - new Date(i.prazo + 'T12:00:00')) / 86400000);
        return `• ${c.nome} — ${dias} dia(s) de atraso`;
      }).join('\n');
  }
  if (tipo === 'aguardando_faturamento') {
    const STATUS = ['Links enviados', 'Aguardando', 'Faturado parcial'];
    const lista = clientes.filter(c => STATUS.includes(c.status));
    if (!lista.length) return null;
    const total = lista.reduce((s, c) => s + (Number(c.total) || 0), 0);
    return `💰 *Clientes aguardando faturamento* (${lista.length}) — ${fmtMoedaBR(total)}\n\n` +
      lista.slice(0, 20).map(c => `• ${c.nome} — ${fmtMoedaBR(c.total)} (${c.status})`).join('\n');
  }
  if (tipo === 'sem_prazo') {
    const lista = clientes.filter(c => {
      const i = impl[c.id] || {};
      return i.etapa !== 'processo_finalizado' && !i.prazo;
    });
    if (!lista.length) return null;
    return `📅 *Clientes sem prazo de implantação* (${lista.length})\n\n` +
      lista.slice(0, 20).map(c => `• ${c.nome}`).join('\n');
  }
  if (tipo === 'leads_sem_contato') {
    const lista = leads.filter(l => l.status === 'novo' && !l.primeiroContatoEm);
    if (!lista.length) return null;
    return `🎯 *Leads sem contato* (${lista.length})\n\n` +
      lista.slice(0, 20).map(l => {
        const dias = l.criadoEm ? Math.floor((Date.now() - new Date(l.criadoEm).getTime()) / 86400000) : '?';
        return `• ${l.nome || 'Sem nome'} — há ${dias} dia(s)`;
      }).join('\n');
  }
  if (tipo === 'resumo_dia') {
    const hojeStr = new Date().toISOString().slice(0, 10);
    const novos = clientes.filter(c => (c.criadoEm || '').startsWith(hojeStr));
    const leadsHoje = leads.filter(l => (l.criadoEm || '').startsWith(hojeStr));
    return `☀️ *Resumo do dia*\n\n` +
      `• Clientes cadastrados hoje: ${novos.length}\n` +
      `• Leads recebidos hoje: ${leadsHoje.length}\n` +
      `• Total de clientes: ${clientes.length}`;
  }
  return null;
}

exports.gatilhosAgendados = functions.pubsub
  .schedule('every 30 minutes')
  .timeZone('America/Sao_Paulo')
  .onRun(async () => {
    try {
      const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
      const horaAtual = `${String(agora.getHours()).padStart(2, '0')}:${agora.getMinutes() < 30 ? '00' : '30'}`;
      const diaSemana = agora.getDay(); // 0=domingo
      const diaMes = agora.getDate();

      const snap = await db.collection('gatilhos').get();
      const gatilhos = [];
      snap.forEach(d => gatilhos.push({ id: d.id, ...d.data() }));
      const agendados = gatilhos.filter(g => g.ativo !== false && g.evento === 'agendado');

      for (const g of agendados) {
        if ((g.horario || '') !== horaAtual) continue;
        const freq = g.frequencia || 'diario';
        if (freq === 'semanal' && Number(g.diaSemana) !== diaSemana) continue;
        if (freq === 'mensal' && Number(g.diaMes) !== diaMes) continue;
        if (freq === 'dias_uteis' && (diaSemana === 0 || diaSemana === 6)) continue;

        let relatorio = '';
        if (g.relatorio) {
          relatorio = await montarRelatorio(g.relatorio);
          if (!relatorio) {
            console.log(`[gatilho agendado] "${g.nome}" — relatório vazio, nada a enviar`);
            continue;
          }
        }
        const aberturaFixa = aplicarVariaveis(g.mensagem || '', montarVariaveis('agendado', {}));

        const destinos = await resolverDestinos(g.destino, {});
        for (const d of destinos) {
          // A IA escreve só a abertura; a lista do relatório vai como está
          let texto;
          if (g.usarIA) {
            const abertura = await gerarMensagemIA({
              instrucao: aplicarVariaveis(g.instrucaoIA || g.mensagem || 'Avise que segue o relatório abaixo.', montarVariaveis('agendado', {})),
              dados: { itens_no_relatorio: (relatorio.match(/^•/gm) || []).length },
              destinatario: (d.nome || '').split(' ')[0],
              textoFallback: aberturaFixa,
            });
            texto = relatorio ? `${abertura}\n\n${relatorio}` : abertura;
          } else {
            texto = relatorio ? (aberturaFixa ? `${aberturaFixa}\n\n${relatorio}` : relatorio) : aberturaFixa;
          }
          const numero = await obterNumeroDatafy({
            numeroId: g.numeroId || null,
            finalidade: g.finalidade || 'interno',
          });
          let destinoNum = String(d.numero).replace(/\D/g, '');
          if (!destinoNum.startsWith('55') || destinoNum.length < 12) {
            destinoNum = '55' + destinoNum.replace(/^0+/, '');
          }
          const r = await chamarDatafy({
            token: numero.token, path: '/messages/send/text',
            method: 'POST', body: { to: destinoNum, text: texto },
          });
          await db.collection('gatilhos_log').add({
            gatilhoId: g.id, gatilhoNome: g.nome, evento: 'agendado',
            destinatario: d.nome, destino: destinoNum,
            mensagem: texto.slice(0, 500), sucesso: r.ok,
            comIA: !!g.usarIA,
            erro: r.ok ? '' : JSON.stringify(r.data).slice(0, 300),
            data: new Date().toISOString(),
          });
        }
        await db.collection('gatilhos').doc(g.id).set({
          ultimoDisparo: new Date().toISOString(),
          totalDisparos: (g.totalDisparos || 0) + 1,
        }, { merge: true });
      }
    } catch (err) {
      console.error('[gatilhos agendados] erro:', err.message);
    }
    return null;
  });

// Disparo manual — botão "Testar agora" no painel
exports.gatilhoTestar = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const { gatilhoId } = req.body || {};
    if (!gatilhoId) throw new Error('Informe o gatilho.');
    const g = (await db.collection('gatilhos').doc(gatilhoId).get()).data();
    if (!g) throw new Error('Gatilho não encontrado.');

    // Dados fictícios para os eventos, ou relatório real para os agendados
    const exemplo = {
      nome: 'CLIENTE DE TESTE LTDA', empresa: 'CLIENTE DE TESTE LTDA',
      cnpj: '00.000.000/0001-00', contato: 'FULANO', tel: '(43) 99999-9999',
      email: 'teste@exemplo.com', cidade: 'IBAITI', uf: 'PR',
      plano: 'Pro', vendedor: 'TESTE', status: 'Faturado', func: 10,
      equipTipo: 'EVO FACIAL 40', vS: 149, vI: 300, vE: 1150, total: 1599,
      titulo: 'SOLICITAÇÃO DE TESTE', clienteNome: 'CLIENTE DE TESTE LTDA',
      categoria: 'Financeiro', prioridade: 'Alta', descricao: 'Mensagem de teste do gatilho.',
      telefone: '(43) 99999-9999', origem: 'Teste', campanha: 'Campanha teste',
      solucao: 'Relógio de ponto fixo', funcionarios: 'De 6 a 10 funcionários',
    };

    const varsTeste = montarVariaveis(g.evento || 'cliente_criado', exemplo, {
      etapaNova: 'Em Configuração', etapaAntiga: 'Venda Fechada', clienteNome: exemplo.nome,
    });
    let relatorioTeste = '';
    if (g.evento === 'agendado' && g.relatorio) {
      relatorioTeste = (await montarRelatorio(g.relatorio)) || '_(nenhum item pendente neste momento)_';
    }
    const textoFixoTeste = aplicarVariaveis(g.mensagem || '', varsTeste);

    const destinos = await resolverDestinos(g.destino, exemplo);
    if (!destinos.length) throw new Error('Nenhum destinatário com celular cadastrado.');

    const resultados = [];
    let previa = '';
    for (const d of destinos) {
      let texto = g.usarIA
        ? await gerarMensagemIA({
            instrucao: aplicarVariaveis(g.instrucaoIA || g.mensagem, varsTeste),
            dados: varsTeste,
            destinatario: (d.nome || '').split(' ')[0],
            textoFallback: textoFixoTeste,
          })
        : textoFixoTeste;
      if (relatorioTeste) texto = texto ? `${texto}\n\n${relatorioTeste}` : relatorioTeste;
      texto = `🧪 *TESTE DO GATILHO "${g.nome}"*\n\n${texto}`;
      if (!previa) previa = texto;
      const numero = await obterNumeroDatafy({ numeroId: g.numeroId || null, finalidade: g.finalidade || 'interno' });
      let destinoNum = String(d.numero).replace(/\D/g, '');
      if (!destinoNum.startsWith('55') || destinoNum.length < 12) destinoNum = '55' + destinoNum.replace(/^0+/, '');
      const r = await chamarDatafy({ token: numero.token, path: '/messages/send/text', method: 'POST', body: { to: destinoNum, text: texto } });
      resultados.push({ para: d.nome, numero: destinoNum, ok: r.ok, erro: r.ok ? null : (r.data?.error?.message || JSON.stringify(r.data).slice(0, 200)) });
    }
    res.status(200).json({ ok: true, previa, resultados });
  } catch (err) {
    console.error('[gatilhoTestar] erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// REDAÇÃO COM IA — evita que os avisos virem "mensagem de robô"
//
// Em vez de um texto fixo repetido, a IA reescreve o aviso a cada disparo:
// muda a saudação, a ordem das frases e o jeito de dizer, mantendo os dados
// exatos. Se a OpenAI falhar, cai no texto fixo do gatilho.
// ═══════════════════════════════════════════════════════════════════════════

function saudacaoPorHora() {
  const h = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).getHours();
  if (h < 12) return 'manhã';
  if (h < 18) return 'tarde';
  return 'noite';
}

const PROMPT_BASE = `Você escreve avisos internos de WhatsApp para a equipe da Guion Informática,
uma revenda de sistemas de controle de ponto (Secullum) no interior do Paraná.

COMO ESCREVER
- Fale como um colega de trabalho falaria, não como um sistema.
- Tom profissional, porém leve e direto. Nada de formalidade engessada.
- Comece cumprimentando a pessoa pelo primeiro nome.
- Varie a forma de escrever a cada mensagem: mude a saudação, a ordem das
  informações e as palavras. Duas mensagens seguidas nunca devem parecer iguais.
- Português do Brasil, no máximo 4 linhas curtas.
- Pode usar 1 ou 2 emojis, sem exagero. Nem toda mensagem precisa de emoji.
- Use *asterisco* para negrito (padrão do WhatsApp) no que for mais importante.

REGRAS RÍGIDAS
- Use apenas os dados fornecidos. Nunca invente nome, valor, data ou situação.
- Não escreva "esta é uma mensagem automática" nem nada parecido.
- Não repita o nome da pessoa mais de uma vez.
- Não assine a mensagem.
- Responda somente com o texto final da mensagem, sem aspas e sem comentários.`;

async function gerarMensagemIA({ instrucao, dados, destinatario, textoFallback }) {
  const key = OPENAI_KEY;
  if (!key) return textoFallback || instrucao;
  try {
    const contexto = Object.entries(dados || {})
      .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n');

    const userMsg = [
      `Escreva a mensagem para: ${destinatario || 'colega de equipe'}`,
      `Período do dia: ${saudacaoPorHora()}`,
      ``,
      `O QUE COMUNICAR:`,
      instrucao,
      ``,
      `DADOS DISPONÍVEIS:`,
      contexto || '(sem dados adicionais)',
    ].join('\n');

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 300,
        temperature: 1.0,        // variação alta é o objetivo aqui
        presence_penalty: 0.6,   // empurra para construções diferentes
        frequency_penalty: 0.4,
        messages: [
          { role: 'system', content: PROMPT_BASE },
          { role: 'user', content: userMsg },
        ],
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.error('[IA] erro OpenAI:', data?.error?.message);
      return textoFallback || instrucao;
    }
    const texto = (data.choices?.[0]?.message?.content || '').trim();
    return texto || textoFallback || instrucao;
  } catch (err) {
    console.error('[IA] falha ao gerar:', err.message);
    return textoFallback || instrucao;
  }
}

// Endpoint para o botão "Ver exemplos" no editor de gatilho
exports.gatilhoPreverIA = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const { instrucao, dados = {}, destinatario = 'Matheus', quantidade = 3 } = req.body || {};
    if (!instrucao) throw new Error('Descreva o que a mensagem deve comunicar.');
    const n = Math.min(Math.max(Number(quantidade) || 3, 1), 4);
    const textos = [];
    for (let i = 0; i < n; i++) {
      textos.push(await gerarMensagemIA({ instrucao, dados, destinatario }));
    }
    res.status(200).json({ ok: true, textos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SECULLUM — API Revendas (Área Restrita)
// Base: https://apirevendas.secullum.com.br/webhook.aspx
// Auth: Bearer <token vinculado ao usuário Administrador da revenda>
//
// LIMITES DA API (documentação oficial):
//  · GET consulta UM banco por vez, pelo código. Não há busca por CNPJ
//    nem listagem de todos os bancos da revenda.
//  · POST aceita apenas: 1 Bloquear · 2 Solicitar cancelamento ·
//    8 Desbloquear · 10 Ativar · 16 Outras solicitações ·
//    21 Inserir notificação · 22 Remover notificação.
//  · Alterar plano ou limite de funcionários não existe como endpoint:
//    vai como tipo 16 com justificativa, que abre chamado na Secullum.
//
// O token fica em Firestore (config/secullum), nunca no navegador.
// ═══════════════════════════════════════════════════════════════════════════

const SECULLUM_URL = 'https://apirevendas.secullum.com.br/webhook.aspx';

async function tokenSecullum() {
  const snap = await db.collection('config').doc('secullum').get();
  const t = snap.exists ? (snap.data().token || '') : '';
  if (!t) throw new Error('Token da Secullum não configurado. Cadastre em Configurações > Integrações.');
  return t;
}

async function consultarBancoSecullum(codigo) {
  const token = await tokenSecullum();
  const resp = await fetch(`${SECULLUM_URL}/?id=${encodeURIComponent(codigo)}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const txt = await resp.text();
  let data; try { data = txt ? JSON.parse(txt) : {}; } catch (_) { data = { raw: txt }; }
  if (!resp.ok) {
    const msg = data?.erro || data?.error || `HTTP ${resp.status}`;
    throw new Error(msg);
  }
  // A API devolve um array com um item
  return Array.isArray(data) ? (data[0] || null) : data;
}

// Consulta o status de um banco
exports.secullumConsultar = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const { codigo } = req.body || {};
    if (!codigo) throw new Error('Informe o código do banco.');
    const dados = await consultarBancoSecullum(codigo);
    if (!dados) throw new Error('Banco não encontrado ou não vinculado a esta revenda.');
    res.status(200).json({ ok: true, dados });
  } catch (err) {
    console.error('[secullum] consulta:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Executa uma ação administrativa
exports.secullumAcao = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const { codigo, tipoSolicitacao, justificativa, clienteId, clienteNome, usuario } = req.body || {};
    if (!codigo) throw new Error('Informe o código do banco.');
    if (!tipoSolicitacao) throw new Error('Informe o tipo da solicitação.');
    if (!justificativa || !String(justificativa).trim()) throw new Error('A justificativa é obrigatória.');
    if (String(justificativa).length > 350) throw new Error('A justificativa passa de 350 caracteres.');

    const token = await tokenSecullum();
    const body = {
      bancoServicoWebCodigo: Number(codigo),
      tipoSolicitacao: Number(tipoSolicitacao),
      justificativa: String(justificativa).trim(),
    };
    const resp = await fetch(SECULLUM_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const txt = await resp.text();
    let data; try { data = txt ? JSON.parse(txt) : {}; } catch (_) { data = { raw: txt }; }

    const NOMES = {
      1: 'Bloquear banco', 2: 'Solicitar cancelamento de contrato',
      8: 'Desbloquear banco', 10: 'Ativar banco',
      16: 'Outras solicitações', 21: 'Inserir notificação', 22: 'Remover notificação',
    };
    const nomeAcao = NOMES[Number(tipoSolicitacao)] || `Tipo ${tipoSolicitacao}`;

    // Registra sempre, dando ou não certo
    await db.collection('secullum_log').add({
      codigo: String(codigo), clienteId: clienteId || '', clienteNome: clienteNome || '',
      tipoSolicitacao: Number(tipoSolicitacao), acao: nomeAcao,
      justificativa: String(justificativa).trim(),
      usuario: usuario || '—', sucesso: resp.ok,
      resposta: JSON.stringify(data).slice(0, 500),
      data: new Date().toISOString(),
    });
    if (clienteId) {
      await db.collection('historico_cliente').add({
        clienteId, clienteNome: clienteNome || '',
        tipo: 'secullum_acao',
        descricao: `${resp.ok ? '' : '[FALHOU] '}Secullum — ${nomeAcao} (banco ${codigo}). Motivo: ${justificativa}`,
        usuario: usuario || '—', data: new Date().toISOString(),
      });
    }

    if (!resp.ok) {
      res.status(resp.status).json({ error: data?.erro || data?.error || `HTTP ${resp.status}`, detalhe: data });
      return;
    }
    res.status(200).json({ ok: true, acao: nomeAcao, resposta: data });
  } catch (err) {
    console.error('[secullum] ação:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Sincroniza em lote os clientes que já têm código cadastrado
exports.secullumSincronizar = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const snap = await db.collection('clientes').get();
    const alvos = [];
    snap.forEach(d => {
      const c = d.data();
      if (c.codigoBancoSecullum) alvos.push({ id: d.id, nome: c.nome || '', codigo: c.codigoBancoSecullum });
    });
    if (!alvos.length) {
      res.status(200).json({ ok: true, total: 0, sucesso: 0, falhas: 0, mensagem: 'Nenhum cliente com código da Secullum cadastrado.' });
      return;
    }
    let sucesso = 0, falhas = 0;
    const erros = [];
    for (const a of alvos) {
      try {
        const d = await consultarBancoSecullum(a.codigo);
        if (!d) throw new Error('não encontrado');
        await db.collection('clientes').doc(a.id).set({
          secullum_sync: {
            razaoSocial: d.RazaoSocial || d.Nome || '',
            documento: d.Documento || '',
            quantidadePessoas: d.QuantidadePessoas ?? null,
            limitePessoas: d.LimitePessoas ?? null,
            limiteEquipamentos: d.LimiteEquipamentos ?? null,
            plano: d.Plano || '',
            periodoMeses: d.Periodo_meses ?? null,
            ativadoEm: d.Ativado_em || '',
            validade: d.Validade || null,
            dataExclusao: d.DataExclusao || null,
            vencimentoContrato: d.vencimentoContrato || '',
            gestaoArquivos: d.RA_GestaoArquivos || '',
            ferias: d.RA_Ferias || '',
            software: d.Software || '',
            atualizadoEm: new Date().toISOString(),
          },
        }, { merge: true });
        sucesso++;
      } catch (e) {
        falhas++;
        erros.push(`${a.nome} (${a.codigo}): ${e.message}`);
      }
      // Respiro entre chamadas para não sobrecarregar a API
      await new Promise(r => setTimeout(r, 250));
    }
    await db.collection('sync_log').add({
      tipo: 'secullum', total: alvos.length, sucesso, falhas,
      erros: erros.slice(0, 20), data: new Date().toISOString(),
    });
    res.status(200).json({ ok: true, total: alvos.length, sucesso, falhas, erros: erros.slice(0, 20) });
  } catch (err) {
    console.error('[secullum] sync:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// LEMBRETE DE APRESENTAÇÃO — avisa quem vai apresentar, X minutos antes
//
// Roda a cada 5 minutos. Para cada lead com apresentação marcada, verifica se
// já entrou na janela do lembrete e envia uma única vez (apresLembreteEnviado).
// Se o lead for remarcado, a flag volta a false e o aviso é enviado de novo.
// ═══════════════════════════════════════════════════════════════════════════

exports.lembreteApresentacao = functions.pubsub
  .schedule('every 5 minutes')
  .timeZone('America/Sao_Paulo')
  .onRun(async () => {
    try {
      const snap = await db.collection('leads').get();
      const pendentes = [];
      snap.forEach(d => {
        const l = { id: d.id, ...d.data() };
        if (!l.apresData || !l.apresResponsavelId) return;
        if (l.apresLembreteEnviado) return;
        const minutos = Number(l.apresLembrete) || 0;
        if (minutos <= 0) return;
        const dt = new Date(`${l.apresData}T${l.apresHora || '09:00'}:00-03:00`);
        if (isNaN(dt.getTime())) return;
        const faltam = dt.getTime() - Date.now();
        // Dentro da janela e ainda não passou da hora
        if (faltam <= minutos * 60000 && faltam > -300000) pendentes.push({ lead: l, dt, faltam });
      });

      if (!pendentes.length) return null;

      const usnap = await db.collection('usuarios').get();
      const usuarios = [];
      usnap.forEach(d => usuarios.push({ id: d.id, ...d.data() }));

      for (const p of pendentes) {
        const l = p.lead;
        const u = usuarios.find(x => x.id === l.apresResponsavelId);
        if (!u || !u.celular) {
          console.log(`[apresentacao] "${l.nome}" — responsável sem celular, pulando`);
          continue;
        }
        const minutosFalta = Math.max(Math.round(p.faltam / 60000), 0);
        const horaTxt = l.apresHora || '—';
        const dataTxt = new Date(l.apresData + 'T12:00:00').toLocaleDateString('pt-BR');

        const dadosMsg = {
          lead: l.nome || '', telefone: l.telefone || '', email: l.email || '',
          data: dataTxt, hora: horaTxt, minutos_restantes: minutosFalta,
          local: l.apresLocal || '', observacoes: l.apresObs || '',
          solucao: l.solucao || '', funcionarios: l.funcionarios || '',
        };

        const instrucao = [
          `Lembre que há uma apresentação marcada em ${minutosFalta} minutos, às ${horaTxt} do dia ${dataTxt}.`,
          `Cliente: ${l.nome || ''}${l.telefone ? ', telefone ' + l.telefone : ''}.`,
          l.apresLocal ? `Local ou forma: ${l.apresLocal}.` : '',
          l.solucao ? `O cliente procura: ${l.solucao}.` : '',
          l.apresObs ? `Pontos anotados: ${l.apresObs}` : '',
          'Deseje uma boa apresentação.',
        ].filter(Boolean).join(' ');

        const fallback =
          `📅 *Apresentação em ${minutosFalta} min*\n\n` +
          `*${(l.nome || '').toUpperCase()}*\n` +
          `${dataTxt} às ${horaTxt}\n` +
          (l.apresLocal ? `Local: ${l.apresLocal}\n` : '') +
          (l.telefone ? `Contato: ${l.telefone}\n` : '') +
          (l.apresObs ? `\n${l.apresObs}` : '');

        const texto = await gerarMensagemIA({
          instrucao,
          dados: dadosMsg,
          destinatario: (u.nome || '').split(' ')[0],
          textoFallback: fallback,
        });

        try {
          const numero = await obterNumeroDatafy({ finalidade: 'comercial' });
          let destino = String(u.celular).replace(/\D/g, '');
          if (!destino.startsWith('55') || destino.length < 12) destino = '55' + destino.replace(/^0+/, '');
          const r = await chamarDatafy({
            token: numero.token, path: '/messages/send/text',
            method: 'POST', body: { to: destino, text: texto },
          });
          await db.collection('leads').doc(l.id).set({
            apresLembreteEnviado: true,
            apresLembreteEnviadoEm: new Date().toISOString(),
            historico: [
              ...(l.historico || []),
              {
                evento: 'lembrete',
                detalhe: `Lembrete da apresentação enviado para ${u.nome || u.email}`,
                data: new Date().toISOString(), usuario: 'Sistema',
              },
            ],
          }, { merge: true });
          await db.collection('gatilhos_log').add({
            gatilhoNome: 'Lembrete de apresentação', evento: 'apresentacao',
            destinatario: u.nome || u.email, destino,
            mensagem: texto.slice(0, 500), comIA: true, sucesso: r.ok,
            erro: r.ok ? '' : JSON.stringify(r.data).slice(0, 300),
            data: new Date().toISOString(),
          });
          console.log(`[apresentacao] "${l.nome}" -> ${u.nome}: ${r.ok ? 'enviado' : 'falhou'}`);
        } catch (e) {
          console.error(`[apresentacao] erro em "${l.nome}":`, e.message);
        }
      }
    } catch (err) {
      console.error('[apresentacao] erro geral:', err.message);
    }
    return null;
  });
