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

// Cada deploy de prévia na Vercel ganha um endereço novo. Fixar a lista fazia
// o navegador barrar a chamada e mostrar só "Failed to fetch", sem explicar
// nada. Agora qualquer endereço do projeto na Vercel é aceito.
function origemPermitida(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (/^http:\/\/localhost:\d+$/.test(origin)) return true;
  return /^https:\/\/[a-z0-9-]*secullum-crm[a-z0-9-]*\.vercel\.app$/i.test(origin);
}

function setCors(req, res) {
  const origin = req.headers.origin || '';
  const allowed = origemPermitida(origin) ? origin : ALLOWED_ORIGINS[0];
  if (origin && !origemPermitida(origin)) {
    console.warn('[cors] origem recusada:', origin);
  }
  res.set('Access-Control-Allow-Origin', allowed);
  res.set('Vary', 'Origin');
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

          // ── Já existe esse contato? ────────────────────────────────────
          // A mesma pessoa costuma chegar por dois caminhos: manda mensagem no
          // WhatsApp e preenche o formulário do anúncio. Sem esta busca, o
          // formulário criava um segundo lead — um só com nome e telefone, e
          // outro completo. Aqui os dados do anúncio enriquecem o que já existe.
          const telNovo = String(campos.telefone || '').replace(/\D/g, '');
          const mailNovo = String(campos.email || '').toLowerCase().trim();
          let alvo = null;

          if (telNovo || mailNovo) {
            const todos = await db.collection('leads').get();
            todos.forEach(d => {
              if (alvo) return;
              const l = d.data();
              if (String(l.leadgenId || '') === String(leadId)) { alvo = d.id; return; }
              const t = String(l.telefone || '').replace(/\D/g, '');
              if (telNovo && t && t.slice(-8) === telNovo.slice(-8)) { alvo = d.id; return; }
              const e = String(l.email || '').toLowerCase().trim();
              if (mailNovo && e && e === mailNovo) { alvo = d.id; }
            });
          }

          if (alvo) {
            // Não sobrescreve o que o vendedor já preencheu à mão: só completa
            const limpo = Object.fromEntries(
              Object.entries(leadDoc).filter(([k, v]) => v !== '' && v != null && k !== 'status' && k !== 'criadoEm')
            );
            await db.collection('leads').doc(alvo).set(limpo, { merge: true });
            console.log('[metaLeads] lead existente enriquecido:', alvo, '←', leadId);
          } else {
            // Mesmo id usado pelo sync da planilha: quem chega pelos dois
            // caminhos cai no mesmo documento em vez de duplicar.
            await db.collection('leads').doc('lead_meta_' + leadId).set(leadDoc, { merge: true });
            console.log('[metaLeads] lead novo:', leadId, campos.nome || '(sem nome)');
          }
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
    // Id derivado do dado, nunca de Date.now(): duas execuções simultâneas do
    // sync gravam no mesmo documento em vez de criar o lead duas vezes.
    const docId = leadId ? 'lead_meta_' + leadId
                : telNum ? 'lead_tel_' + telNum
                : email  ? 'lead_mail_' + email.replace(/[^a-z0-9]/gi, '_').slice(0, 60)
                         : 'lead_' + nome.toLowerCase().replace(/[^a-z0-9]/gi, '_').slice(0, 60);

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
  if (evento === 'campanha_concluida') {
    return { ...base, ...c };   // já vem pronto de montarDadosCampanha
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
        let ultimoTextoIA = '';

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
                historico: g.ultimasMensagens || [],
                tom: await tomDeVoz(),
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
          if (g.usarIA) ultimoTextoIA = texto;
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
          ...(g.usarIA && ultimoTextoIA
            ? { ultimasMensagens: [...(g.ultimasMensagens || []), ultimoTextoIA].slice(-5) }
            : {}),
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
          let aberturaGerada = '';
          if (g.usarIA) {
            const abertura = await gerarMensagemIA({
              instrucao: aplicarVariaveis(g.instrucaoIA || g.mensagem || 'Avise que segue o relatório abaixo.', montarVariaveis('agendado', {})),
              dados: { itens_no_relatorio: (relatorio.match(/^•/gm) || []).length },
              destinatario: (d.nome || '').split(' ')[0],
              textoFallback: aberturaFixa,
              historico: g.ultimasMensagens || [],   // para não repetir o de ontem
              tom: await tomDeVoz(),
            });
            aberturaGerada = abertura;
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
        // Guarda o que a IA escreveu, para o próximo disparo sair diferente
        if (g.usarIA && aberturaGerada) {
          const hist = [...(g.ultimasMensagens || []), aberturaGerada].slice(-5);
          await db.collection('gatilhos').doc(g.id).set({ ultimasMensagens: hist }, { merge: true });
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

async function gerarMensagemIA({ instrucao, dados, destinatario, textoFallback, historico, tom }) {
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
      // Sem isso a IA escreve do zero todo dia e repete a construção por acaso.
      ...((historico || []).length ? [
        ``,
        `VOCÊ JÁ ESCREVEU ASSIM NOS ÚLTIMOS DIAS — NÃO REPITA:`,
        ...historico.slice(-5).map((h, i) => `${i + 1}. ${String(h).slice(0, 220)}`),
        ``,
        `Escreva de um jeito claramente diferente destes: outra abertura, outra ordem das informações, outras palavras. O conteúdo é o mesmo, a forma não pode ser.`,
      ] : []),
      ...(tom ? ['', `TOM DE VOZ:`, tom] : []),
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
// LEMBRETES DE REUNIÃO — três momentos, configurados por gatilho
//
// Roda a cada 5 minutos e atende três momentos, cada um ligado ou desligado
// no gatilho de evento "reuniao_lembrete" (Configurações > Gatilhos):
//
//   1. RESUMO DA MANHÃ  no horário escolhido, cada responsável recebe a lista
//                       das reuniões dele no dia. O gestor, quando definido,
//                       recebe a lista completa da equipe.
//   2. ANTES            X minutos antes, conforme o campo Lembrete do lead.
//   3. NA HORA          no horário da reunião, para o responsável e — quando
//                       ligado — para o próprio cliente.
//
// O link enviado é a sala fixa do responsável (usuarios/{id}.salaReuniao) ou,
// quando preenchido, o link específico daquela reunião (leads/{id}.apresLink).
//
// Cada momento tem a sua própria marca de "já enviei", então remarcar a
// reunião faz todos os avisos valerem de novo.
//
// Sem nenhum gatilho cadastrado, cai no comportamento antigo: só o aviso de
// X minutos antes, para não parar de avisar de um deploy para o outro.
// ═══════════════════════════════════════════════════════════════════════════

function agoraSP() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}
function ymdSP(d) {
  const x = d || agoraSP();
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
function dtReuniao(l) {
  return new Date(`${l.apresData}T${l.apresHora || '09:00'}:00-03:00`);
}
// Link específico da reunião ganha da sala fixa do vendedor
function linkDaReuniao(lead, usuario) {
  const especifico = String((lead && lead.apresLink) || '').trim();
  if (especifico) return especifico;
  return String((usuario && usuario.salaReuniao) || '').trim();
}

async function enviarLembrete({ finalidade, para, texto, gatilhoNome, destinatario, contexto }) {
  const numero = await obterNumeroDatafy({ finalidade: finalidade || 'comercial' });
  const destino = normalizarNumero(para);
  const r = await chamarDatafy({
    token: numero.token, path: '/messages/send/text',
    method: 'POST', body: { to: destino, text: texto },
  });
  await db.collection('gatilhos_log').add({
    gatilhoNome: gatilhoNome || 'Lembrete de reunião',
    evento: 'reuniao_lembrete',
    destinatario: destinatario || '', destino,
    mensagem: String(texto).slice(0, 500),
    contexto: contexto || '',
    sucesso: r.ok,
    erro: r.ok ? '' : JSON.stringify(r.data).slice(0, 300),
    data: new Date().toISOString(),
  });
  if (!r.ok) console.error(`[reuniao] falha ao enviar para ${destinatario}:`, JSON.stringify(r.data).slice(0, 200));
  return r;
}

// Texto de uma reunião dentro da lista do resumo
function linhaResumo(l, comLink, link) {
  const hora = l.apresHora || '—';
  const partes = [`• *${hora}* — ${(l.nome || 'SEM NOME').toUpperCase()}`];
  if (l.apresLocal) partes.push(`  ${l.apresLocal}`);
  if (l.telefone) partes.push(`  ${l.telefone}`);
  if (comLink && link) partes.push(`  ${link}`);
  return partes.join('\n');
}

exports.lembreteApresentacao = functions.pubsub
  .schedule('every 5 minutes')
  .timeZone('America/Sao_Paulo')
  .onRun(async () => {
    try {
      // ── Gatilho que comanda os lembretes ────────────────────────────────
      const gsnap = await db.collection('gatilhos').get();
      const gatilhos = [];
      gsnap.forEach(d => gatilhos.push({ id: d.id, ...d.data() }));
      const g = gatilhos.find(x => x.ativo !== false && x.evento === 'reuniao_lembrete') || {
        nome: 'Lembrete de reunião (padrão)',
        momentos: { resumo: false, antes: true, hora: false },
        usarIA: true, enviarLink: false, avisarCliente: false,
        finalidade: 'comercial', horaResumo: '08:00',
      };
      const momentos = g.momentos || { resumo: false, antes: true, hora: false };
      const finalidade = g.finalidade || 'comercial';
      const comLink = g.enviarLink !== false;

      // ── Dados base ──────────────────────────────────────────────────────
      const [lsnap, usnap] = await Promise.all([
        db.collection('leads').get(),
        db.collection('usuarios').get(),
      ]);
      const usuarios = [];
      usnap.forEach(d => usuarios.push({ id: d.id, ...d.data() }));
      const acharUsuario = id => usuarios.find(u => u.id === id);

      const reunioes = [];
      lsnap.forEach(d => {
        const l = { id: d.id, ...d.data() };
        if (!l.apresData || !l.apresResponsavelId) return;
        const dt = dtReuniao(l);
        if (isNaN(dt.getTime())) return;
        reunioes.push({ ...l, _dt: dt });
      });

      const agora = agoraSP();
      const hoje = ymdSP(agora);
      const hm = `${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;

      // ════════════════════════════════════════════════════════════════════
      // 1 · RESUMO DA MANHÃ
      // ════════════════════════════════════════════════════════════════════
      // Só dispara na janela de 2h após o horário escolhido. Sem isso, criar o
      // gatilho às 15h faria o "resumo da manhã" sair no mesmo instante.
      const minutosDoDia = t => {
        const [h, m] = String(t || '08:00').split(':');
        return (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0);
      };
      const atraso = minutosDoDia(hm) - minutosDoDia(g.horaResumo || '08:00');
      const naJanelaResumo = atraso >= 0 && atraso <= 120;

      if (momentos.resumo && g.id && (g.ultimoResumoEm || '') !== hoje && naJanelaResumo) {
        // Marca antes de enviar: se algo falhar no meio, não reenvia a lista toda
        await db.collection('gatilhos').doc(g.id).set({ ultimoResumoEm: hoje }, { merge: true });

        const doDia = reunioes
          .filter(r => r.apresData === hoje)
          .sort((a, b) => (a.apresHora || '').localeCompare(b.apresHora || ''));

        if (doDia.length) {
          // Cada responsável recebe as reuniões dele
          const porResponsavel = {};
          doDia.forEach(r => {
            (porResponsavel[r.apresResponsavelId] = porResponsavel[r.apresResponsavelId] || []).push(r);
          });

          for (const [uid, lista] of Object.entries(porResponsavel)) {
            const u = acharUsuario(uid);
            if (!u || !u.celular) {
              console.log(`[reuniao/resumo] responsável ${uid} sem celular, pulando`);
              continue;
            }
            const corpo = lista.map(r => linhaResumo(r, comLink, linkDaReuniao(r, u))).join('\n\n');
            const cabecalho = `📅 *Suas reuniões de hoje* (${lista.length})`;
            const fallback = `${cabecalho}\n\n${corpo}`;
            const texto = g.usarIA
              ? await gerarMensagemIA({
                  instrucao: [
                    `Avise que a pessoa tem ${lista.length} reunião(ões) hoje.`,
                    'Faça só a abertura, em uma ou duas linhas — a lista vem logo abaixo, não repita os dados dela.',
                    (g.instrucaoIA || '').trim(),
                  ].filter(Boolean).join(' '),
                  dados: { total_reunioes: lista.length, data: agora.toLocaleDateString('pt-BR') },
                  destinatario: (u.nome || '').split(' ')[0],
                  textoFallback: cabecalho,
                }).then(t => `${t}\n\n${corpo}`)
              : fallback;

            await enviarLembrete({
              finalidade, para: u.celular, texto,
              gatilhoNome: g.nome, destinatario: u.nome || u.email, contexto: 'resumo do dia',
            });
          }

          // Gestor recebe a agenda completa da equipe
          const gestor = g.gestorId ? acharUsuario(g.gestorId) : null;
          if (gestor && gestor.celular) {
            const corpo = doDia.map(r => {
              const u = acharUsuario(r.apresResponsavelId);
              const quem = r.apresResponsavelNome || (u && u.nome) || '—';
              return `${linhaResumo(r, comLink, linkDaReuniao(r, u))}\n  com ${quem}`;
            }).join('\n\n');
            await enviarLembrete({
              finalidade, para: gestor.celular,
              texto: `📊 *Agenda da equipe hoje* (${doDia.length})\n\n${corpo}`,
              gatilhoNome: g.nome, destinatario: gestor.nome || gestor.email, contexto: 'resumo do gestor',
            });
          }
          console.log(`[reuniao/resumo] ${doDia.length} reunião(ões), ${Object.keys(porResponsavel).length} responsável(is)`);
        } else {
          console.log('[reuniao/resumo] nenhuma reunião hoje — ninguém foi avisado');
        }
      }

      // ════════════════════════════════════════════════════════════════════
      // 2 · X MINUTOS ANTES
      // ════════════════════════════════════════════════════════════════════
      if (momentos.antes !== false) {
        for (const l of reunioes) {
          if (l.apresLembreteEnviado) continue;
          const minutos = Number(l.apresLembrete) || 0;
          if (minutos <= 0) continue;
          const faltam = l._dt.getTime() - Date.now();
          if (!(faltam <= minutos * 60000 && faltam > -300000)) continue;

          const u = acharUsuario(l.apresResponsavelId);
          if (!u || !u.celular) {
            console.log(`[reuniao/antes] "${l.nome}" — responsável sem celular, pulando`);
            continue;
          }

          const minutosFalta = Math.max(Math.round(faltam / 60000), 0);
          const horaTxt = l.apresHora || '—';
          const dataTxt = new Date(l.apresData + 'T12:00:00').toLocaleDateString('pt-BR');
          const link = linkDaReuniao(l, u);

          const instrucao = [
            `Lembre que há uma reunião em ${minutosFalta} minutos, às ${horaTxt} do dia ${dataTxt}.`,
            `Cliente: ${l.nome || ''}${l.telefone ? ', telefone ' + l.telefone : ''}.`,
            l.apresLocal ? `Local ou forma: ${l.apresLocal}.` : '',
            l.solucao ? `O cliente procura: ${l.solucao}.` : '',
            l.apresObs ? `Pontos anotados: ${l.apresObs}` : '',
            (g.instrucaoIA || '').trim() || 'Deseje uma boa reunião.',
          ].filter(Boolean).join(' ');

          const fallback =
            `📅 *Reunião em ${minutosFalta} min*\n\n` +
            `*${(l.nome || '').toUpperCase()}*\n` +
            `${dataTxt} às ${horaTxt}\n` +
            (l.apresLocal ? `Local: ${l.apresLocal}\n` : '') +
            (l.telefone ? `Contato: ${l.telefone}\n` : '') +
            (l.apresObs ? `\n${l.apresObs}` : '');

          let texto = g.usarIA === false
            ? aplicarVariaveis(g.mensagem || '', {
                lead: l.nome || '', telefone: l.telefone || '', data: dataTxt, hora: horaTxt,
                minutos_restantes: minutosFalta, local: l.apresLocal || '',
                observacoes: l.apresObs || '', solucao: l.solucao || '',
                responsavel: u.nome || '', link,
              }) || fallback
            : await gerarMensagemIA({
                instrucao,
                dados: {
                  lead: l.nome || '', telefone: l.telefone || '', data: dataTxt, hora: horaTxt,
                  minutos_restantes: minutosFalta, local: l.apresLocal || '',
                  solucao: l.solucao || '', funcionarios: l.funcionarios || '',
                },
                destinatario: (u.nome || '').split(' ')[0],
                textoFallback: fallback,
              });

          if (comLink && link && !texto.includes(link)) texto += `\n\n🔗 ${link}`;

          try {
            await enviarLembrete({
              finalidade, para: u.celular, texto,
              gatilhoNome: g.nome, destinatario: u.nome || u.email, contexto: `antes — ${l.nome || l.id}`,
            });
            await db.collection('leads').doc(l.id).set({
              apresLembreteEnviado: true,
              apresLembreteEnviadoEm: new Date().toISOString(),
              historico: [
                ...(l.historico || []),
                {
                  evento: 'lembrete',
                  detalhe: `Lembrete da reunião enviado para ${u.nome || u.email}`,
                  data: new Date().toISOString(), usuario: 'Sistema',
                },
              ],
            }, { merge: true });
          } catch (e) {
            console.error(`[reuniao/antes] erro em "${l.nome}":`, e.message);
          }
        }
      }

      // ════════════════════════════════════════════════════════════════════
      // 3 · NA HORA DA REUNIÃO
      // ════════════════════════════════════════════════════════════════════
      if (momentos.hora) {
        for (const l of reunioes) {
          if (l.apresAvisoHoraEnviado) continue;
          const faltam = l._dt.getTime() - Date.now();
          // Janela de 6 min cobre o intervalo de 5 min da execução
          if (!(faltam <= 0 && faltam > -360000)) continue;

          const u = acharUsuario(l.apresResponsavelId);
          const link = linkDaReuniao(l, u);
          const horaTxt = l.apresHora || '—';

          // Responsável
          if (u && u.celular) {
            let texto =
              `⏰ *Sua reunião é agora*\n\n` +
              `*${(l.nome || '').toUpperCase()}*\n` +
              `${horaTxt}` +
              (l.apresLocal ? `\nLocal: ${l.apresLocal}` : '') +
              (l.telefone ? `\nContato: ${l.telefone}` : '');
            if (comLink && link) texto += `\n\n🔗 ${link}`;
            try {
              await enviarLembrete({
                finalidade, para: u.celular, texto,
                gatilhoNome: g.nome, destinatario: u.nome || u.email, contexto: `na hora — ${l.nome || l.id}`,
              });
            } catch (e) {
              console.error(`[reuniao/hora] erro ao avisar responsável de "${l.nome}":`, e.message);
            }
          }

          // Cliente — só chega se ele respondeu nas últimas 24h (regra da Meta)
          if (g.avisarCliente && l.telefone) {
            const primeiro = (l.nome || '').split(' ')[0];
            const nomeResp = l.apresResponsavelNome || (u && u.nome) || 'nosso consultor';
            let texto =
              `Oi${primeiro ? ', ' + primeiro : ''}! Passando para lembrar da nossa reunião das ${horaTxt}.` +
              `\n\n${nomeResp} já está te esperando.`;
            if (comLink && link) texto += `\n\n🔗 ${link}`;
            try {
              const r = await enviarLembrete({
                finalidade, para: l.telefone, texto,
                gatilhoNome: g.nome, destinatario: l.nome || 'Cliente', contexto: `na hora (cliente) — ${l.nome || l.id}`,
              });
              if (!r.ok) {
                console.log(`[reuniao/hora] cliente "${l.nome}" não recebeu — provável janela de 24h fechada`);
              }
            } catch (e) {
              console.error(`[reuniao/hora] erro ao avisar cliente de "${l.nome}":`, e.message);
            }
          }

          await db.collection('leads').doc(l.id).set({
            apresAvisoHoraEnviado: true,
            apresAvisoHoraEnviadoEm: new Date().toISOString(),
          }, { merge: true });
        }
      }
    } catch (err) {
      console.error('[reuniao] erro geral:', err.message, err.stack);
    }
    return null;
  });

// ═══════════════════════════════════════════════════════════════════════════
// ANÚNCIOS — templates, campanhas e atendimento por IA
//
// ╔═ REGRA DE NEGÓCIO ═══════════════════════════════════════════════════════
// A Meta só permite TEXTO LIVRE para quem enviou mensagem nas últimas 24h.
// Para iniciar conversa é obrigatório TEMPLATE APROVADO. Campanhas de
// marketing têm limite diário por qualidade do número (começa em 250/dia).
// Enviar demais ou receber denúncias derruba a qualidade e pode suspender.
// ═══════════════════════════════════════════════════════════════════════════

// ─── TEMPLATES ───────────────────────────────────────────────────────────────

exports.datafyTemplates = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const { acao = 'listar', numeroId, template, nome } = req.body || {};
    const numero = await obterNumeroDatafy({ numeroId });

    if (acao === 'listar') {
      const r = await chamarDatafy({ token: numero.token, path: '/templates' });
      res.status(r.ok ? 200 : r.status).json(r.data);
      return;
    }
    if (acao === 'criar') {
      if (!template) throw new Error('Envie os dados do template.');
      const r = await chamarDatafy({
        token: numero.token, path: '/templates', method: 'POST', body: template,
      });
      // A Datafy às vezes responde 200 com {error:true} no corpo, e às vezes
      // manda o erro em formato diferente. Antes a tela mostrava só "true".
      const deuRuim = !r.ok || r.data?.error === true || r.data?.error === 'true';
      await db.collection('anuncios_log').add({
        tipo: 'template_criado', nome: template.name || '',
        sucesso: !deuRuim, resposta: JSON.stringify(r.data).slice(0, 600),
        enviado: JSON.stringify(template).slice(0, 600),
        usuario: req.body.usuario || '—', data: new Date().toISOString(),
      });
      if (deuRuim) {
        console.error('[templates] recusado:', JSON.stringify(r.data));
        res.status(r.status && r.status !== 200 ? r.status : 400).json({
          error: msgErroDatafy(r),
          detalhe: r.data,
        });
        return;
      }
      res.status(200).json(r.data);
      return;
    }
    if (acao === 'remover') {
      if (!nome) throw new Error('Informe o nome do template.');
      const r = await chamarDatafy({
        token: numero.token, path: `/templates/${encodeURIComponent(nome)}`, method: 'DELETE',
      });
      res.status(r.ok ? 200 : r.status).json(r.data);
      return;
    }
    throw new Error('Ação desconhecida: ' + acao);
  } catch (err) {
    console.error('[anuncios] templates:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── DISPARO DE CAMPANHA ─────────────────────────────────────────────────────

function normalizarNumero(tel) {
  let n = String(tel || '').replace(/\D/g, '');
  if (!n) return '';
  if (!n.startsWith('55') || n.length < 12) n = '55' + n.replace(/^0+/, '');
  return n;
}

// Envia uma mensagem da campanha para um destinatário
// A Datafy/Meta devolve erro em formatos diferentes conforme o caso. Antes o
// código só olhava r.data.error.message e, quando não achava, gravava a string
// "falha" — que não diz nada a quem está olhando a tela. Agora tenta todos os
// formatos conhecidos e, em último caso, guarda o corpo cru da resposta.
function msgErroDatafy(r) {
  const d = r && r.data;
  const bruto =
    d?.error?.message ||
    d?.error?.error_user_msg ||
    d?.error_description ||
    d?.message ||
    (Array.isArray(d?.errors) ? d.errors.map(e => e.message || e).join(' | ') : '') ||
    (typeof d === 'string' ? d : '') ||
    d?.raw ||
    '';
  const status = r?.status ? `HTTP ${r.status}` : '';
  const codigo = d?.error?.code ? ` [${d.error.code}]` : '';
  if (bruto) return `${status}${codigo}: ${bruto}`.replace(/^: /, '');
  const cru = (() => { try { return JSON.stringify(d); } catch (_) { return String(d); } })();
  return `${status || 'falha'} — resposta: ${String(cru).slice(0, 160)}`;
}

async function enviarDaCampanha(campanha, lead, token) {
  const destino = normalizarNumero(lead.telefone);
  if (!destino) throw new Error('sem telefone');

  const primeiroNome = String(lead.nome || '').trim().split(' ')[0] || 'tudo bem';

  if (campanha.tipo === 'template') {
    // Substitui as variáveis do template pelos dados do lead
    const vars = (campanha.variaveis || []).map(v => {
      const mapa = {
        nome: lead.nome || '', primeiro_nome: primeiroNome,
        telefone: lead.telefone || '', email: lead.email || '',
        solucao: lead.solucao || '', funcionarios: lead.funcionarios || '',
        campanha: lead.campanha || '',
      };
      return String(v).replace(/\{\{(\w+)\}\}/g, (m, k) => mapa[k] ?? '');
    });
    const body = {
      to: destino,
      template: campanha.template,
      language: campanha.idioma || 'pt_BR',
    };
    // Variável de template não aceita quebra de linha, tabulação nem 5 espaços
    // seguidos. A Meta rejeita no envio, não no cadastro — e o erro é obscuro.
    if (vars.length) body.body = vars.map(v =>
      String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/\s{4,}/g, ' ').trim()
    );
    if (campanha.headerMidia) body.header = { image: { link: campanha.headerMidia } };
    return chamarDatafy({ token, path: '/messages/send/template', method: 'POST', body });
  }

  // Canal QR: texto livre sem depender da janela de 24h, com o risco que ela
  // existe para evitar. Só entra quando a campanha foi marcada assim.
  if (campanha.canal === 'qr') {
    const t = String(campanha.texto || '')
      .replace(/\{\{nome\}\}/g, lead.nome || '')
      .replace(/\{\{primeiro_nome\}\}/g, primeiroNome)
      .replace(/\{\{solucao\}\}/g, lead.solucao || '')
      .replace(/\{\{funcionarios\}\}/g, lead.funcionarios || '');
    return enviarPorQR(campanha._numeroQR || {}, destino, t);
  }

  // Texto livre — só vale para quem respondeu nas últimas 24h
  const texto = String(campanha.texto || '')
    .replace(/\{\{nome\}\}/g, lead.nome || '')
    .replace(/\{\{primeiro_nome\}\}/g, primeiroNome)
    .replace(/\{\{solucao\}\}/g, lead.solucao || '')
    .replace(/\{\{funcionarios\}\}/g, lead.funcionarios || '');

  if (campanha.tipo === 'imagem' && campanha.midia) {
    return chamarDatafy({
      token, path: '/messages/send/image', method: 'POST',
      body: { to: destino, image: { link: campanha.midia, caption: texto } },
    });
  }
  if (campanha.tipo === 'cta' && campanha.linkUrl) {
    // A Datafy espera button_label e button_url SOLTOS no corpo. Enviar
    // aninhado em { button: {...} } devolve 400 dizendo que são obrigatórios.
    return chamarDatafy({
      token, path: '/messages/send/cta', method: 'POST',
      body: {
        to: destino,
        body: texto,
        button_label: String(campanha.linkTexto || 'Saiba mais').slice(0, 20),
        button_url: campanha.linkUrl,
      },
    });
  }
  if (campanha.tipo === 'botoes' && (campanha.botoes || []).length) {
    return chamarDatafy({
      token, path: '/messages/send/buttons', method: 'POST',
      body: {
        to: destino, body: texto,
        buttons: campanha.botoes.map((b, i) => ({ id: 'btn_' + i, title: String(b).slice(0, 20) })),
      },
    });
  }
  return chamarDatafy({
    token, path: '/messages/send/text', method: 'POST',
    body: { to: destino, text: texto },
  });
}

// Processa a fila de uma campanha, respeitando o limite diário
// Transforma o resultado da campanha em números e listas prontas para leitura
function montarDadosCampanha(c) {
  const dest = c.destinatarios || [];
  const enviados = dest.filter(d => d.enviadoEm);
  const falhas = dest.filter(d => d.erro);

  // Separa o que a Meta barrou pela janela de 24h do resto
  const ehJanela = e => /24|window|re-?engag|outside|template|não .*sess|no .*session/i.test(String(e || ''));
  const foraJanela = falhas.filter(d => ehJanela(d.erro));
  const outrasFalhas = falhas.filter(d => !ehJanela(d.erro));

  // Agrupa os motivos, tirando número e id para erros iguais caírem juntos
  const grupos = {};
  falhas.forEach(d => {
    const chave = String(d.erro).replace(/\b\d{8,}\b/g, '…').slice(0, 140);
    grupos[chave] = (grupos[chave] || 0) + 1;
  });
  const motivos = Object.entries(grupos)
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `• ${n}× ${m}`)
    .join('\n');

  const lista = (arr, limite = 25) => {
    if (!arr.length) return '';
    const nomes = arr.slice(0, limite).map(d => `• ${d.nome || d.telefone}`);
    if (arr.length > limite) nomes.push(`• …e mais ${arr.length - limite}`);
    return nomes.join('\n');
  };

  const publico = [
    c.filtroStatus && c.filtroStatus !== 'todos' ? `etapa ${c.filtroStatus}` : '',
    c.filtroOrigem && c.filtroOrigem !== 'todas' ? `origem ${c.filtroOrigem}` : '',
    c.filtroPorte && c.filtroPorte !== 'todos' ? `porte ${c.filtroPorte}` : '',
  ].filter(Boolean).join(', ') || 'todos os leads';

  const total = dest.length;
  const taxa = total ? Math.round((enviados.length / total) * 100) : 0;

  return {
    campanha: c.nome || '(sem nome)',
    tipo: c.tipo === 'template' ? `template ${c.template || ''}` : c.tipo,
    canal: c.canal === 'qr' ? 'QR Code' : 'API oficial',
    publico,
    mensagem: String(c.texto || c.template || '').slice(0, 300),
    total: String(total),
    enviados: String(enviados.length),
    falhas: String(falhas.length),
    fora_janela: String(foraJanela.length),
    outras_falhas: String(outrasFalhas.length),
    taxa: `${taxa}%`,
    motivos: motivos || '(sem falhas)',
    lista_enviados: lista(enviados),
    lista_falhas: lista(falhas),
    criada_por: c.criadaPor || '—',
    // Bloco pronto, para quem não quiser montar o texto na mão
    relatorio: [
      `📊 *${c.nome || 'Campanha'}* — resultado`,
      `Público: ${publico} · ${c.canal === 'qr' ? 'QR Code' : 'API oficial'}`,
      ``,
      `✅ Entregues: ${enviados.length} de ${total} (${taxa}%)`,
      falhas.length ? `❌ Falharam: ${falhas.length}` : '',
      foraJanela.length ? `⏰ Fora da janela de 24h: ${foraJanela.length}` : '',
      falhas.length ? `\n*Motivos*\n${motivos}` : '',
      enviados.length ? `\n*Receberam*\n${lista(enviados)}` : '',
      falhas.length ? `\n*Não receberam*\n${lista(falhas)}` : '',
    ].filter(Boolean).join('\n'),
  };
}

async function processarCampanha(campanhaId, limiteNesteCiclo = 40, reenviarFalhas = false) {
  const ref = db.collection('campanhas').doc(campanhaId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Campanha não encontrada.');
  const c = { id: snap.id, ...snap.data() };
  if (!reenviarFalhas && (c.status === 'concluida' || c.status === 'pausada')) return { enviados: 0, motivo: c.status };

  const numero = await obterNumeroDatafy({ numeroId: c.numeroId, finalidade: c.finalidade || 'comercial' });
  const ehQR = c.canal === 'qr' || (numero.tipo || 'oficial') === 'qr';
  if (ehQR) c._numeroQR = numero;

  // No canal QR o disparo respeita horário comercial. Mensagem de madrugada
  // multiplica a chance de bloqueio e de denúncia.
  if (ehQR && c.respeitarHorario !== false && !dentroDaJanela(c.janelaInicio, c.janelaFim)) {
    return { enviados: 0, motivo: 'fora da janela de horário' };
  }

  // Quem ainda não recebeu. Com reenviarFalhas, quem falhou volta para a fila —
  // sem isso um erro passageiro travava o destinatário para sempre.
  const fila = (c.destinatarios || []).filter(d => !d.enviadoEm && (reenviarFalhas || !d.erro));
  if (!fila.length) {
    await ref.set({ status: 'concluida', concluidaEm: new Date().toISOString() }, { merge: true });
    return { enviados: 0, motivo: 'fila vazia' };
  }

  // Limite diário da campanha
  const hoje = new Date().toISOString().slice(0, 10);
  const enviadosHoje = (c.destinatarios || [])
    .filter(d => d.enviadoEm && d.enviadoEm.startsWith(hoje)).length;
  const limiteDia = ehQR ? tetoDoDia(numero, c.limiteDiario) : (Number(c.limiteDiario) || 200);
  const podeHoje = Math.max(limiteDia - enviadosHoje, 0);
  if (podeHoje === 0) return { enviados: 0, motivo: 'limite diário atingido' };

  const lote = fila.slice(0, Math.min(limiteNesteCiclo, podeHoje));
  const atualizados = [...(c.destinatarios || [])];
  let ok = 0, falhas = 0;

  for (const alvo of lote) {
    const idx = atualizados.findIndex(d => d.leadId === alvo.leadId);
    if (idx >= 0 && atualizados[idx].erro) { delete atualizados[idx].erro; delete atualizados[idx].erroEm; }
    try {
      const r = await enviarDaCampanha(c, alvo, numero.token);
      if (r.ok) {
        atualizados[idx] = {
          ...alvo,
          enviadoEm: new Date().toISOString(),
          messageId: r.data?.messages?.[0]?.id || '',
        };
        ok++;
      } else {
        const detalhe = msgErroDatafy(r);
        atualizados[idx] = { ...alvo, erro: detalhe.slice(0, 200), erroEm: new Date().toISOString() };
        console.error(`[campanha] ${alvo.nome || alvo.telefone}: ${detalhe}`);
        falhas++;
      }
    } catch (e) {
      atualizados[idx] = { ...alvo, erro: String(e.message).slice(0, 200) };
      falhas++;
    }
    // Intervalo entre envios: rajada derruba a qualidade do número. No canal QR
    // o tempo é sorteado dentro de uma faixa, porque ritmo cravado denuncia robô.
    await new Promise(r => setTimeout(r,
      ehQR ? intervaloSorteado(c.intervaloMin || 30, c.intervaloMax || 75)
           : (Number(c.intervaloSegundos) || 3) * 1000));

    // Freio de emergência: muitas falhas seguidas costuma ser sessão caída ou
    // número já bloqueado. Continuar só piora.
    if (ehQR) {
      const ultimos = atualizados.filter(d => d.erro || d.enviadoEm).slice(-6);
      const seguidas = (() => { let n = 0; for (let i = ultimos.length - 1; i >= 0; i--) { if (ultimos[i].erro) n++; else break; } return n; })();
      if (seguidas >= (Number(c.pararAposFalhas) || 5)) {
        await ref.set({
          destinatarios: atualizados, status: 'pausada',
          pausadaEm: new Date().toISOString(),
          motivoPausa: `${seguidas} falhas seguidas — conferir a conexão do número antes de continuar`,
        }, { merge: true });
        console.error(`[campanha] pausada por ${seguidas} falhas seguidas`);
        return { enviados: ok, falhas, pausada: true, motivo: `${seguidas} falhas seguidas` };
      }
    }
  }

  const restante = atualizados.filter(d => !d.enviadoEm && !d.erro).length;
  await ref.set({
    destinatarios: atualizados,
    enviados: atualizados.filter(d => d.enviadoEm).length,
    falhas: atualizados.filter(d => d.erro).length,
    status: restante === 0 ? 'concluida' : 'enviando',
    ultimoEnvioEm: new Date().toISOString(),
    ...(restante === 0 ? { concluidaEm: new Date().toISOString() } : {}),
  }, { merge: true });

  // Campanha fechou: avisa quem acompanha, com o resultado mastigado
  if (restante === 0 && !c.relatorioEnviadoEm) {
    try {
      await ref.set({ relatorioEnviadoEm: new Date().toISOString() }, { merge: true });
      await processarGatilhos('campanha_concluida', montarDadosCampanha({ ...c, destinatarios: atualizados }));
    } catch (e) {
      console.error('[campanha] relatório final:', e.message);
    }
  }

  return { enviados: ok, falhas, restante };
}

exports.campanhaDisparar = functions.runWith({ timeoutSeconds: 540 })
  .https.onRequest(async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    try {
      const { campanhaId, limite, reenviarFalhas } = req.body || {};
      if (!campanhaId) throw new Error('Informe a campanha.');
      const r = await processarCampanha(campanhaId, Number(limite) || 40, reenviarFalhas === true);
      res.status(200).json({ ok: true, ...r });
    } catch (err) {
      console.error('[campanha] disparo:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

// Continua as campanhas em andamento e inicia as agendadas
exports.campanhasAgendadas = functions.runWith({ timeoutSeconds: 540 })
  .pubsub.schedule('every 15 minutes')
  .timeZone('America/Sao_Paulo')
  .onRun(async () => {
    try {
      const snap = await db.collection('campanhas').get();
      const agora = Date.now();
      for (const d of snap.docs) {
        const c = { id: d.id, ...d.data() };
        if (c.status === 'enviando') {
          await processarCampanha(c.id, 40);
          continue;
        }
        if (c.status === 'agendada' && c.agendadaPara) {
          const quando = new Date(c.agendadaPara).getTime();
          if (!isNaN(quando) && quando <= agora) {
            await d.ref.set({ status: 'enviando', iniciadaEm: new Date().toISOString() }, { merge: true });
            await processarCampanha(c.id, 40);
          }
        }
      }
    } catch (err) {
      console.error('[campanhas agendadas] erro:', err.message);
    }
    return null;
  });

// ─── ATENDIMENTO POR IA ──────────────────────────────────────────────────────
// Recebe as respostas pelo webhook da Datafy e responde com a OpenAI.
// A autonomia é configurável em config/atendimento_ia.
// URL a cadastrar no painel da Datafy:
//   https://us-central1-secullum-crm.cloudfunctions.net/datafyWebhook

const NIVEIS_AUTONOMIA = {
  basico: {
    pode: 'Responder apenas dúvidas gerais sobre o que é o sistema de ponto, como funciona o registro por facial, quais equipamentos existem e prazos de instalação.',
    naoPode: 'NUNCA informar preços, valores, descontos, condições de pagamento ou prazos de contrato. NUNCA prometer nada. Nesses casos, diga que um consultor vai passar as informações e encerre o assunto.',
  },
  comercial: {
    pode: 'Responder dúvidas sobre o sistema, equipamentos, e informar os preços da tabela quando perguntarem. Pode explicar planos e formas de pagamento.',
    naoPode: 'NUNCA conceder desconto, prazo especial ou condição fora da tabela. Não fechar contrato nem confirmar pedido — isso é sempre com um consultor.',
  },
  completo: {
    pode: 'Conduzir a conversa comercial: tirar dúvidas, informar preços, explicar planos, sugerir a melhor solução pelo porte da empresa e propor um horário de apresentação.',
    naoPode: 'NUNCA conceder desconto fora da tabela nem confirmar fechamento de contrato sem um consultor.',
  },
};

// Conhecimento acumulado nas correções — entra no prompt de toda conversa
async function baseConhecimento() {
  try {
    const snap = await db.collection('base_conhecimento').get();
    const itens = [];
    snap.forEach(d => { const x = d.data(); if (x.ativo !== false) itens.push(x); });
    if (!itens.length) return '';
    // Teto alto porque a base cresce com a importação de arquivos.
    // Correções (prioridade 2) vêm antes dos importados (prioridade 1).
    return itens
      .sort((a, b) => (b.prioridade || 0) - (a.prioridade || 0))
      .slice(0, 200)
      .map(i => `P: ${i.pergunta}\nR: ${i.resposta}`)
      .join('\n\n');
  } catch (e) { return ''; }
}

// ═══════════════════════════════════════════════════════════════════════════
// SEÇÃO DE PREÇOS — amarrada nos cadastros do orçamento
//
// A IA NÃO tem tabela de preços própria. Ela lê exatamente o mesmo cadastro
// que o orçamento usa:
//   orc_servicos  → planos, licenças e serviços  (Config > Orçamento > Serviços)
//   equipamentos  → EVO 40, EVO 45 e afins       (Config > Equipamentos)
//
// Em config/precos ficam SÓ os ids liberados para a IA e as regras. Nenhum
// valor é copiado. Mudou o preço no cadastro — ou entrou uma promoção — a IA
// passa a falar o valor novo na mesma hora, sem ninguém cadastrar duas vezes.
//
// O valor promocional vigente ganha do preço de venda, igual no orçamento.
// O preço de custo NUNCA vai para o prompt.
// ═══════════════════════════════════════════════════════════════════════════

function precoNum(v) {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v == null ? '' : v).replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

// Espelha equipEmPromocao() do App.js — datas vazias = sem limite daquele lado
function equipPromoAtiva(e) {
  if (!e) return false;
  if (precoNum(e.valorPromocional) <= 0) return false;
  const hoje = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  hoje.setHours(12, 0, 0, 0);
  if (e.promoInicio) {
    const ini = new Date(e.promoInicio + 'T00:00:00');
    if (!isNaN(ini.getTime()) && hoje < ini) return false;
  }
  if (e.promoFim) {
    const fim = new Date(e.promoFim + 'T23:59:59');
    if (!isNaN(fim.getTime()) && hoje > fim) return false;
  }
  return true;
}
function equipValorAtual(e) {
  if (!e) return 0;
  return equipPromoAtiva(e) ? precoNum(e.valorPromocional) : precoNum(e.precoVenda);
}
// Piso de venda: promocional manda; sem promocional, o limite é o custo.
function equipPiso(e) {
  if (!e) return 0;
  const promo = precoNum(e.valorPromocional);
  return promo > 0 ? promo : precoNum(e.precoCusto);
}

async function precosParaPrompt(cfg) {
  // No nível básico a IA não pode falar de valores — nem recebe a tabela.
  if (cfg.autonomia === 'basico') return '';

  let regras = {};
  try {
    const snap = await db.collection('config').doc('precos').get();
    if (snap.exists) regras = snap.data() || {};
  } catch (e) {
    console.error('[precos] erro ao ler config/precos:', e.message);
  }

  const liberadosServ = Array.isArray(regras.servicosLiberados) ? regras.servicosLiberados : null;
  const liberadosEquip = Array.isArray(regras.equipamentosLiberados) ? regras.equipamentosLiberados : null;
  const podeNegociar = regras.negociar === true;

  const linhas = [];

  try {
    // ── Planos e serviços ────────────────────────────────────────────────────
    const sSnap = await db.collection('orc_servicos').get();
    const servicos = [];
    sSnap.forEach(d => {
      const s = { id: d.id, ...d.data() };
      // null = nada configurado ainda: por segurança não libera nada
      if (liberadosServ && liberadosServ.includes(s.id)) servicos.push(s);
    });
    if (servicos.length) {
      linhas.push('Planos e serviços (mensalidade do sistema):');
      servicos
        .sort((a, b) => precoNum(a.valor) - precoNum(b.valor))
        .forEach(s => {
          const desc = s.descricao ? ` — ${s.descricao}` : '';
          linhas.push(`- ${s.nome}: ${fmtMoedaBR(precoNum(s.valor))}${desc}`);
        });
    }

    // ── Equipamentos ─────────────────────────────────────────────────────────
    const eSnap = await db.collection('equipamentos').get();
    const equips = [];
    eSnap.forEach(d => {
      const e = { id: d.id, ...d.data() };
      if (liberadosEquip && liberadosEquip.includes(e.id)) equips.push(e);
    });
    if (equips.length) {
      linhas.push('', 'Equipamentos (valor único, à parte da mensalidade):');
      equips
        .sort((a, b) => equipValorAtual(a) - equipValorAtual(b))
        .forEach(e => {
          if (e.requerPagamento === false) {
            linhas.push(`- ${e.nome}: sem custo`);
            return;
          }
          const promo = equipPromoAtiva(e);
          const valor = fmtMoedaBR(equipValorAtual(e));
          const selo = promo ? ' (promoção vigente)' : '';
          const piso = podeNegociar && equipPiso(e) > 0
            ? ` [piso interno: ${fmtMoedaBR(equipPiso(e))} — NUNCA revele este número ao cliente]`
            : '';
          linhas.push(`- ${e.nome}: ${valor}${selo}${piso}`);
        });
    }
  } catch (e) {
    console.error('[precos] erro ao montar tabela:', e.message);
  }

  if (regras.condicoes) linhas.push('', 'Condições de pagamento:', regras.condicoes);
  if (regras.observacoes) linhas.push('', regras.observacoes);

  // Nada liberado: cai para a tabela antiga em texto livre, se existir
  if (!linhas.length) return cfg.tabelaPrecos || '';

  linhas.push(
    '',
    'REGRAS SOBRE VALORES (siga à risca):',
    '- Informe apenas os valores exatos escritos acima. Nunca calcule, estime nem arredonde.',
    '- Se perguntarem um valor que não está aqui, diga que vai confirmar com o consultor. Nunca chute.',
    podeNegociar
      ? '- Você pode negociar até o piso interno indicado, mas nunca diga que existe um piso nem revele o número. Abaixo dele, só com um consultor.'
      : '- Nunca conceda desconto, parcelamento ou condição fora do que está escrito. Se insistirem, ofereça chamar um consultor em vez de negociar.'
  );
  return linhas.join('\n');
}

async function configAtendimento() {
  const snap = await db.collection('config').doc('atendimento_ia').get();
  const d = snap.exists ? snap.data() : {};
  return {
    numeroTeste: String(d.numeroTeste || '').replace(/\D/g, ''),
    modoTreino: d.modoTreino !== false,
    ativo: d.ativo === true,
    autonomia: d.autonomia || 'basico',
    personalidade: d.personalidade || '',
    tabelaPrecos: d.tabelaPrecos || '',
    horarioInicio: d.horarioInicio || '08:00',
    horarioFim: d.horarioFim || '18:00',
    foraHorario: d.foraHorario || 'Recebemos sua mensagem! Nosso atendimento é de segunda a sexta, das 8h às 18h. Retornamos assim que possível 😊',
    palavrasEscalar: d.palavrasEscalar || ['reclamação', 'processo', 'advogado', 'cancelar contrato', 'procon'],
    avisarResponsavel: d.avisarResponsavel !== false,
    responsavelId: d.responsavelId || '',
    maxMensagens: Number(d.maxMensagens) || 12,
    // Desligado de propósito: mensagem de número desconhecido não vira lead
    criarLeadDeDesconhecido: d.criarLeadDeDesconhecido === true,
  };
}

function dentroDoHorario(cfg) {
  const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dia = agora.getDay();
  if (dia === 0 || dia === 6) return false;
  const hm = `${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;
  return hm >= cfg.horarioInicio && hm <= cfg.horarioFim;
}

async function responderComIA({ lead, mensagem, historico, cfg, conhecimento, precos }) {
  if (!OPENAI_KEY) return null;
  const nivel = NIVEIS_AUTONOMIA[cfg.autonomia] || NIVEIS_AUTONOMIA.basico;
  const base = conhecimento !== undefined ? conhecimento : await baseConhecimento();
  const tabela = precos !== undefined ? precos : await precosParaPrompt(cfg);

  const sistema = [
    'Você atende pelo WhatsApp da Guion Informática e Relógio de Ponto, revenda Secullum de sistemas de controle de ponto, em Ibaiti/PR.',
    '',
    'COMO FALAR',
    '- Escreva como uma pessoa do atendimento escreveria: direto, cordial, sem formalidade excessiva.',
    '- Acompanhe o jeito do cliente: se ele escreve curto, responda curto; se é mais formal, acompanhe.',
    '- No máximo 4 linhas por mensagem. Uma pergunta por vez.',
    '- Emoji com moderação, no máximo um por mensagem.',
    '- Nunca diga que é uma inteligência artificial, um robô ou um atendimento automático.',
    '- Não repita o nome da pessoa a toda hora.',
    '',
    'O QUE VOCÊ PODE FAZER',
    nivel.pode,
    '',
    'O QUE VOCÊ NÃO PODE FAZER',
    nivel.naoPode,
    '- Nunca invente informação. Sem certeza, diga que vai confirmar e passar em seguida.',
    '',
    tabela ? 'TABELA DE PREÇOS\n' + tabela : '',
    cfg.personalidade ? '\nORIENTAÇÕES DA EMPRESA\n' + cfg.personalidade : '',
    base ? '\nRESPOSTAS JÁ VALIDADAS PELA EQUIPE\nUse estas como referência de conteúdo e de tom. Adapte as palavras à conversa, não copie literalmente.\n\n' + base : '',
    '',
    'SOBRE ESTE CONTATO',
    `Nome: ${lead.nome || 'não informado'}`,
    lead.funcionarios ? `Porte informado: ${lead.funcionarios}` : '',
    lead.solucao ? `Interesse: ${lead.solucao}` : '',
    lead.sistema_ponto ? `Já usa sistema de ponto: ${lead.sistema_ponto}` : '',
    lead.apresData ? `Tem apresentação marcada para ${lead.apresData} ${lead.apresHora || ''}` : '',
    '',
    'Se perceber que o assunto precisa de uma pessoa (reclamação, negociação, algo fora do seu alcance), diga que vai chamar um consultor e responda apenas com: [ESCALAR]',
  ].filter(Boolean).join('\n');

  const mensagens = [
    { role: 'system', content: sistema },
    ...(historico || []).slice(-cfg.maxMensagens).map(m => ({
      role: m.de === 'cliente' ? 'user' : 'assistant',
      content: m.texto || '',
    })),
    { role: 'user', content: mensagem },
  ];

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini', max_tokens: 350, temperature: 0.8,
        presence_penalty: 0.3, messages: mensagens,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) { console.error('[atendimento] OpenAI:', data?.error?.message); return null; }
    return (data.choices?.[0]?.message?.content || '').trim();
  } catch (e) {
    console.error('[atendimento] erro IA:', e.message);
    return null;
  }
}

exports.datafyWebhook = functions.https.onRequest(async (req, res) => {
  // Verificação do webhook
  if (req.method === 'GET') {
    const challenge = req.query['hub.challenge'];
    if (challenge) { res.status(200).send(challenge); return; }
    res.status(200).send('ok'); return;
  }
  // Responde rápido para a Datafy não reenviar
  res.status(200).send('OK');

  try {
    const body = req.body || {};
    const entradas = body.entry || (body.messages ? [{ changes: [{ value: body }] }] : []);

    for (const entry of entradas) {
      for (const change of (entry.changes || [])) {
        const v = change.value || {};

        // ── STATUS DE ENTREGA ──────────────────────────────────────────────
        // A Meta avisa aqui se a mensagem foi entregue, lida ou falhou. Sem
        // tratar isso, o CRM registrava "enviado" só porque a Datafy aceitou —
        // e mensagem barrada pela janela de 24h passava despercebida.
        for (const st of (v.statuses || [])) {
          try {
            const erroMeta = (st.errors || [])[0] || null;
            await db.collection('whatsapp_status').doc(String(st.id || Date.now())).set({
              messageId: st.id || '',
              destino: String(st.recipient_id || '').replace(/\D/g, ''),
              status: st.status || '',                    // sent | delivered | read | failed
              erroCodigo: erroMeta?.code || '',
              erroTitulo: erroMeta?.title || '',
              erroDetalhe: erroMeta?.error_data?.details || erroMeta?.message || '',
              em: new Date().toISOString(),
            }, { merge: true });
            if (st.status === 'failed') {
              console.error(`[whatsapp] NÃO ENTREGUE para ${st.recipient_id}:`,
                erroMeta?.title || '', erroMeta?.error_data?.details || erroMeta?.message || '');
            }
          } catch (e) { console.error('[whatsapp] status:', e.message); }
        }

        const msgs = v.messages || [];
        if (!msgs.length) continue;

        for (const m of msgs) {
          const de = String(m.from || '').replace(/\D/g, '');
          const texto = m.text?.body
            || m.button?.text
            || m.interactive?.button_reply?.title
            || m.interactive?.list_reply?.title
            || '';
          if (!de) continue;

          const cfgPre = await configAtendimento();

          // ── MODO TREINO ────────────────────────────────────────────────────
          // Mensagens do número de teste não viram lead. Servem para ensinar:
          //   /aprender pergunta | resposta   → grava na base de conhecimento
          //   /esquecer <trecho>              → remove o que casar
          //   /base                           → lista o que já foi ensinado
          //   qualquer outro texto            → conversa normal com a IA
          if (cfgPre.numeroTeste && cfgPre.modoTreino && de.endsWith(cfgPre.numeroTeste.slice(-8))) {
            const numero = await obterNumeroDatafy({ finalidade: 'comercial' });
            const responder = async txt => chamarDatafy({
              token: numero.token, path: '/messages/send/text',
              method: 'POST', body: { to: de, text: txt },
            });
            const t = texto.trim();

            if (t.toLowerCase().startsWith('/aprender')) {
              const corpo = t.slice(9).trim();
              const [perg, resp] = corpo.split('|').map(x => (x || '').trim());
              if (!perg || !resp) {
                await responder('Use assim:\n\n*/aprender* pergunta do cliente *|* como responder\n\nExemplo:\n/aprender tem fidelidade? | Não temos fidelidade. O cliente pode cancelar quando quiser, sem multa.');
              } else {
                await db.collection('base_conhecimento').add({
                  pergunta: perg, resposta: resp, ativo: true, prioridade: 1,
                  origem: 'WhatsApp (treino)', criadoEm: new Date().toISOString(),
                });
                await responder(`✅ Aprendido!\n\n*Quando perguntarem:* ${perg}\n*Vou responder assim:* ${resp}`);
              }
              continue;
            }

            if (t.toLowerCase().startsWith('/esquecer')) {
              const alvo = t.slice(9).trim().toLowerCase();
              if (!alvo) { await responder('Diga o que devo esquecer. Ex: /esquecer fidelidade'); continue; }
              const snapB = await db.collection('base_conhecimento').get();
              let n = 0;
              for (const d2 of snapB.docs) {
                const x = d2.data();
                if (`${x.pergunta} ${x.resposta}`.toLowerCase().includes(alvo)) { await d2.ref.delete(); n++; }
              }
              await responder(n ? `🗑️ ${n} item(ns) removido(s) da base.` : 'Não encontrei nada com esse trecho.');
              continue;
            }

            if (t.toLowerCase() === '/base') {
              const snapB = await db.collection('base_conhecimento').get();
              const itens = [];
              snapB.forEach(d2 => itens.push(d2.data()));
              if (!itens.length) { await responder('A base ainda está vazia. Use /aprender para ensinar.'); continue; }
              const lista = itens.slice(0, 15).map((x, i) => `${i + 1}. ${x.pergunta}`).join('\n');
              await responder(`📚 *Base de conhecimento* (${itens.length} item(ns))\n\n${lista}${itens.length > 15 ? '\n\n_...e outros_' : ''}`);
              continue;
            }

            if (t.toLowerCase() === '/ajuda') {
              await responder('🧪 *Modo treino*\n\nEscreva como um cliente escreveria e eu respondo. Se a resposta não ficou boa, me ensine:\n\n*/aprender* pergunta *|* resposta certa\n*/esquecer* trecho\n*/base* — ver o que já aprendi\n\nTudo que você ensinar vale para as conversas com clientes de verdade.');
              continue;
            }

            // Conversa de teste — a IA responde como responderia a um cliente
            const leadFake = { nome: 'CLIENTE TESTE', funcionarios: '', solucao: '' };
            const histSnap = await db.collection('config').doc('treino_historico').get();
            const hist = histSnap.exists ? (histSnap.data().mensagens || []) : [];
            const conhec = await baseConhecimento();
            const respIA = await responderComIA({
              lead: leadFake, mensagem: t, historico: hist, cfg: cfgPre, conhecimento: conhec,
            });
            const saida = respIA && !respIA.includes('[ESCALAR]')
              ? respIA
              : 'Neste ponto eu passaria a conversa para um consultor.';
            await responder(saida);
            await db.collection('config').doc('treino_historico').set({
              mensagens: [...hist, { de: 'cliente', texto: t, data: new Date().toISOString() },
                                   { de: 'ia', texto: saida, data: new Date().toISOString() }].slice(-40),
              atualizadoEm: new Date().toISOString(),
            }, { merge: true });
            console.log('[treino] respondido ao número de teste');
            continue;
          }

          // Localiza o lead pelo telefone
          const leadsSnap = await db.collection('leads').get();
          let lead = null;
          leadsSnap.forEach(d => {
            const l = d.data();
            const tel = String(l.telefone || '').replace(/\D/g, '');
            if (!tel) return;
            const a = tel.slice(-8), b = de.slice(-8);
            if (a && a === b) lead = { id: d.id, ...l };
          });

          const agora = new Date().toISOString();
          const registro = { de: 'cliente', texto, data: agora, messageId: m.id || '' };

          if (!lead) {
            // ── NÚMERO DESCONHECIDO ────────────────────────────────────────
            // Antes, qualquer mensagem recebida virava lead. Isso enchia a
            // lista de "CONTATO WHATSAPP" vindo de engano, spam e número
            // internacional. Agora fica em quarentena: a mensagem não se
            // perde, mas também não polui o funil.
            // Ligar cfgPre.criarLeadDeDesconhecido volta ao comportamento
            // antigo, aí com id derivado do telefone (nunca duplica).
            const nomePerfil = (v.contacts?.[0]?.profile?.name || '').toUpperCase();

            if (cfgPre.criarLeadDeDesconhecido) {
              await db.collection('leads').doc('lead_wa_' + de).set({
                nome: nomePerfil || 'CONTATO WHATSAPP',
                telefone: de, origem: 'WhatsApp', status: 'novo',
                criadoEm: agora, atualizadoEm: agora,
                conversa: admin.firestore.FieldValue.arrayUnion(registro),
              }, { merge: true });
              console.log('[atendimento] lead criado a partir do WhatsApp:', de);
            } else {
              await db.collection('whatsapp_desconhecidos').doc(de).set({
                telefone: de,
                nomePerfil,
                ultimaMensagem: texto,
                ultimaMensagemEm: agora,
                mensagens: admin.firestore.FieldValue.arrayUnion(registro),
                primeiroContatoEm: agora,
                atendido: false,
              }, { merge: true });
              console.log('[atendimento] número desconhecido em quarentena:', de);
            }
            continue;
          }

          const conversa = [...(lead.conversa || []), registro];
          await db.collection('leads').doc(lead.id).set({
            conversa,
            ultimaMensagemEm: agora,
            aguardandoResposta: true,
            primeiroContatoEm: lead.primeiroContatoEm || agora,
            atualizadoEm: agora,
          }, { merge: true });

          const cfg = cfgPre;
          if (!cfg.ativo) continue;
          if (lead.atendimentoHumano) continue; // alguém assumiu a conversa

          // Fora do horário: aviso único por dia
          if (!dentroDoHorario(cfg)) {
            const hoje = agora.slice(0, 10);
            if (lead.avisoForaHorarioEm?.startsWith(hoje)) continue;
            const numero = await obterNumeroDatafy({ finalidade: 'comercial' });
            await chamarDatafy({
              token: numero.token, path: '/messages/send/text',
              method: 'POST', body: { to: de, text: cfg.foraHorario },
            });
            await db.collection('leads').doc(lead.id).set({
              avisoForaHorarioEm: agora,
              conversa: [...conversa, { de: 'sistema', texto: cfg.foraHorario, data: agora }],
            }, { merge: true });
            continue;
          }

          // Palavras que exigem uma pessoa
          const precisaHumano = (cfg.palavrasEscalar || [])
            .some(p => texto.toLowerCase().includes(String(p).toLowerCase()));

          let resposta = null;
          if (!precisaHumano) {
            resposta = await responderComIA({ lead, mensagem: texto, historico: conversa, cfg });
          }

          if (precisaHumano || !resposta || resposta.includes('[ESCALAR]')) {
            await db.collection('leads').doc(lead.id).set({
              atendimentoHumano: true, escaladoEm: agora,
              motivoEscalada: precisaHumano ? 'Palavra-chave sensível' : 'IA pediu apoio humano',
            }, { merge: true });

            if (cfg.avisarResponsavel) {
              try {
                const usnap = await db.collection('usuarios').get();
                let resp = null;
                usnap.forEach(d => {
                  const u = { id: d.id, ...d.data() };
                  if (cfg.responsavelId && u.id === cfg.responsavelId && u.celular) resp = u;
                });
                if (resp) {
                  const numero = await obterNumeroDatafy({ finalidade: 'interno' });
                  const aviso = `🙋 *Atendimento precisa de você*\n\n*${lead.nome || de}*\n${lead.telefone || de}\n\n_"${texto.slice(0, 180)}"_`;
                  await chamarDatafy({
                    token: numero.token, path: '/messages/send/text',
                    method: 'POST', body: { to: normalizarNumero(resp.celular), text: aviso },
                  });
                }
              } catch (e) { console.error('[atendimento] aviso interno:', e.message); }
            }
            continue;
          }

          // Envia a resposta da IA
          const numero = await obterNumeroDatafy({ finalidade: 'comercial' });
          await chamarDatafy({
            token: numero.token, path: '/messages/send/typing',
            method: 'POST', body: { to: de },
          }).catch(() => {});
          const r = await chamarDatafy({
            token: numero.token, path: '/messages/send/text',
            method: 'POST', body: { to: de, text: resposta },
          });
          await db.collection('leads').doc(lead.id).set({
            conversa: [...conversa, { de: 'ia', texto: resposta, data: new Date().toISOString() }],
            aguardandoResposta: false,
          }, { merge: true });
          console.log(`[atendimento] "${lead.nome}": ${r.ok ? 'respondido' : 'falha ao responder'}`);
        }
      }
    }
  } catch (err) {
    console.error('[atendimento] erro:', err.message, err.stack);
  }
});

// Envio manual pela tela de conversas
exports.conversaEnviar = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const { leadId, texto, usuario } = req.body || {};
    if (!leadId || !texto) throw new Error('Informe o lead e o texto.');
    const snap = await db.collection('leads').doc(leadId).get();
    if (!snap.exists) throw new Error('Lead não encontrado.');
    const lead = snap.data();
    const numero = await obterNumeroDatafy({ finalidade: 'comercial' });
    const r = await chamarDatafy({
      token: numero.token, path: '/messages/send/text',
      method: 'POST', body: { to: normalizarNumero(lead.telefone), text: texto },
    });
    if (!r.ok) throw new Error(r.data?.error?.message || 'Falha ao enviar');
    await db.collection('leads').doc(leadId).set({
      conversa: [...(lead.conversa || []), { de: 'humano', texto, data: new Date().toISOString(), usuario: usuario || '—' }],
      atendimentoHumano: true, aguardandoResposta: false,
      atualizadoEm: new Date().toISOString(),
    }, { merge: true });
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Simulador do CRM — conversa com a IA sem envolver o WhatsApp
exports.iaSimular = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const { mensagem, historico = [], leadExemplo = {} } = req.body || {};
    if (!mensagem) throw new Error('Escreva a mensagem do cliente.');
    const cfg = await configAtendimento();
    const conhecimento = await baseConhecimento();
    const precos = await precosParaPrompt(cfg);
    const lead = {
      nome: leadExemplo.nome || 'CLIENTE TESTE',
      funcionarios: leadExemplo.funcionarios || '',
      solucao: leadExemplo.solucao || '',
      sistema_ponto: leadExemplo.sistema_ponto || '',
    };
    const resposta = await responderComIA({ lead, mensagem, historico, cfg, conhecimento, precos });
    res.status(200).json({
      ok: true,
      resposta: resposta || 'Não consegui gerar a resposta. Verifique a chave da OpenAI.',
      escalou: !!(resposta && resposta.includes('[ESCALAR]')),
      itensNaBase: conhecimento ? conhecimento.split('\n\n').length : 0,
      precosNoPrompt: !!precos,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sugestão de texto para templates de campanha
exports.iaSugerirTemplate = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const { rascunho = '', objetivo = '', publico = '', quantidade = 3, acao = 'sugerir', formato = 'template' } = req.body || {};
    if (!OPENAI_KEY) throw new Error('Chave da OpenAI não configurada.');

    // formato: 'template' (aprovação da Meta, variáveis {{1}}, {{2}}) ou
    //          'campanha' (texto livre da janela de 24h, variáveis nomeadas)
    const ehCampanha = formato === 'campanha';

    const REGRAS_META = [
      ehCampanha
        ? 'REGRAS OBRIGATÓRIAS (boas práticas do WhatsApp — descumprir derruba a qualidade do número):'
        : 'REGRAS OBRIGATÓRIAS DA META (o template é recusado se descumprir):',
      '- Nada de promessa exagerada, urgência falsa ou "última chance".',
      '- Não usar CAIXA ALTA em frases inteiras nem excesso de pontuação.',
      '- Não pedir dados sensíveis (CPF, cartão, senha).',
      '- Máximo 1024 caracteres. Ideal entre 250 e 500.',
      ehCampanha
        ? '- As variáveis disponíveis são: {{primeiro_nome}}, {{nome}}, {{solucao}} e {{funcionarios}}. Escreva-as exatamente assim, com chaves duplas. Nunca começar nem terminar o texto com variável.'
        : '- As variáveis são numeradas: {{1}}, {{2}}, {{3}}. Nunca começar nem terminar o texto com variável.',
      '- Sempre deixar claro quem está falando (a empresa).',
    ].join('\n');

    const CONTEXTO = [
      'A empresa é a Guion Informática e Relógio de Ponto, revenda Secullum de sistemas de controle de ponto,',
      'em Ibaiti/PR. Vende licença mensal do Ponto Web, relógios de ponto facial e biométrico, e ponto por',
      'celular/tablet. O público são empresas pequenas e médias que precisam registrar a jornada dos funcionários',
      'conforme a lei. As dores comuns: folha de ponto em papel, erro no cálculo de horas extras, funcionário',
      'marcando ponto pelo colega, e medo de processo trabalhista.',
    ].join(' ');

    const sistema = [
      ehCampanha
        ? 'Você escreve mensagens de WhatsApp para campanhas enviadas a leads que já conversaram com a empresa nas últimas 24 horas. O tom é de continuação de conversa, não de primeiro contato frio.'
        : 'Você escreve mensagens de primeiro contato por WhatsApp para campanhas de venda.',
      '',
      CONTEXTO,
      '',
      'COMO ESCREVER',
      ehCampanha
        ? '- Comece cumprimentando com a variável {{primeiro_nome}}, que será o primeiro nome da pessoa. Se ajudar a personalizar, use também {{solucao}} (o que a pessoa procura) e {{funcionarios}} (porte da empresa).'
        : '- Comece cumprimentando com a variável {{1}}, que será o PRIMEIRO NOME da pessoa.',
      '- Escreva como uma pessoa escreveria, não como um anúncio. Nada de "aproveite já" ou "imperdível".',
      '- Vá direto ao ponto: em 3 ou 4 linhas curtas a pessoa precisa entender o que é e o que fazer.',
      '- Termine com uma pergunta simples, fácil de responder com uma palavra.',
      '- No máximo 2 emojis na mensagem inteira.',
      '- Português do Brasil, tratamento por você.',
      '',
      REGRAS_META,
      '',
      'Responda APENAS com o texto da mensagem. Sem aspas, sem título, sem comentário.',
      quantidade > 1 ? 'Se pedirem mais de uma versão, separe cada uma com a linha ---' : '',
    ].filter(Boolean).join('\n');

    let pedido;
    if (acao === 'melhorar') {
      pedido = [
        'Melhore a mensagem abaixo mantendo a ideia original.',
        'Ajuste o que estiver fora das regras da Meta, deixe mais natural e mais fácil de responder.',
        '',
        'MENSAGEM ATUAL:',
        rascunho,
        publico ? `\nPÚBLICO: ${publico}` : '',
      ].filter(Boolean).join('\n');
    } else {
      pedido = [
        `Escreva ${quantidade} versões diferentes de mensagem para esta campanha.`,
        objetivo ? `OBJETIVO: ${objetivo}` : 'OBJETIVO: apresentar a solução e despertar interesse.',
        publico ? `PÚBLICO: ${publico}` : '',
        rascunho ? `\nO que já foi escrito (use como ponto de partida):\n${rascunho}` : '',
        '',
        'Cada versão deve ter um ângulo diferente: uma mais direta, uma focada na dor, uma focada no benefício.',
      ].filter(Boolean).join('\n');
    }

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini', max_tokens: 900, temperature: 0.9, presence_penalty: 0.4,
        messages: [{ role: 'system', content: sistema }, { role: 'user', content: pedido }],
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || 'Erro na OpenAI');
    const bruto = (data.choices?.[0]?.message?.content || '').trim();
    const versoes = bruto.split(/\n-{3,}\n/).map(t => t.trim()).filter(Boolean);
    res.status(200).json({ ok: true, versoes: versoes.length ? versoes : [bruto] });
  } catch (err) {
    console.error('[iaSugerirTemplate]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Extrai perguntas e respostas de um texto corrido enviado pelo usuário
exports.iaExtrairConhecimento = functions.runWith({ timeoutSeconds: 300 })
  .https.onRequest(async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    try {
      const { texto = '' } = req.body || {};
      if (!texto.trim()) throw new Error('Envie o conteúdo do arquivo.');
      if (!OPENAI_KEY) throw new Error('Chave da OpenAI não configurada.');

      // Divide textos longos para não estourar o limite do modelo
      const PEDACO = 9000;
      const pedacos = [];
      for (let i = 0; i < texto.length; i += PEDACO) pedacos.push(texto.slice(i, i + PEDACO));

      const sistema = [
        'Você organiza material de apoio ao atendimento em pares de pergunta e resposta.',
        '',
        'A empresa é a Guion Informática e Relógio de Ponto, revenda Secullum de sistemas de controle de ponto.',
        '',
        'REGRAS',
        '- Escreva a pergunta como um cliente perguntaria no WhatsApp, com as palavras dele.',
        '- A resposta deve ser curta e direta, no máximo 3 linhas, pronta para ser enviada.',
        '- Use apenas o que está no texto. Não invente preço, prazo nem condição.',
        '- Ignore índices, sumários, cabeçalhos e rodapés.',
        '- Se um trecho não gerar dúvida de cliente, pule.',
        '',
        'Responda APENAS com JSON válido, sem comentário e sem markdown:',
        '{"itens":[{"pergunta":"...","resposta":"..."}]}',
      ].join('\n');

      const todos = [];
      for (const p of pedacos.slice(0, 8)) {
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
          body: JSON.stringify({
            model: 'gpt-4o-mini', max_tokens: 2500, temperature: 0.3,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: sistema },
              { role: 'user', content: 'Extraia as perguntas e respostas deste material:\n\n' + p },
            ],
          }),
        });
        const data = await resp.json();
        if (!resp.ok) { console.error('[extrair]', data?.error?.message); continue; }
        try {
          const j = JSON.parse(data.choices?.[0]?.message?.content || '{}');
          (j.itens || []).forEach(it => {
            if (it.pergunta && it.resposta) {
              todos.push({ pergunta: String(it.pergunta).trim(), resposta: String(it.resposta).trim() });
            }
          });
        } catch (e) { console.error('[extrair] JSON inválido'); }
      }

      // Remove repetições
      const vistos = new Set();
      const itens = todos.filter(i => {
        const k = i.pergunta.toLowerCase().replace(/[^a-z0-9à-ú ]/gi, '').trim();
        if (vistos.has(k)) return false;
        vistos.add(k);
        return true;
      });

      res.status(200).json({ ok: true, itens, pedacos: pedacos.length });
    } catch (err) {
      console.error('[iaExtrairConhecimento]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

// ═══════════════════════════════════════════════════════════════════════════
// MAILCHIMP — leads viram contatos na audiência, com tag
//
// A régua de 3, 5 e 7 dias NÃO fica aqui. Ela é montada uma vez no Customer
// Journey do Mailchimp, disparada pela tag que este código aplica. Assim você
// muda texto, arte e prazo lá dentro, sem depender de deploy — e o descadastro
// fica sob responsabilidade deles, que é o certo para e-mail de marketing.
//
// Config em config/mailchimp:
//   apiKey      chave da API. O sufixo dela (ex: -us21) é o datacenter
//   audienceId  id da audiência (lista)
//   tag         tag que dispara a jornada. Padrão: "sequencia-oferta"
//   ativo       liga/desliga o envio automático
//   status      "subscribed" (padrão) ou "pending" (com confirmação por e-mail)
// ═══════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');

async function configMailchimp() {
  const snap = await db.collection('config').doc('mailchimp').get();
  const d = snap.exists ? snap.data() : {};
  return {
    apiKey: d.apiKey || '',
    audienceId: d.audienceId || '',
    tag: d.tag || 'sequencia-oferta',
    ativo: d.ativo === true,
    status: d.status === 'pending' ? 'pending' : 'subscribed',
    // arquivar (para de enviar, reversível) | tags (só troca as etiquetas) | nada
    aoConverter: ['arquivar', 'tags', 'nada'].includes(d.aoConverter) ? d.aoConverter : 'arquivar',
  };
}

// O datacenter vem depois do hífen na própria chave
function dcDaChave(apiKey) {
  const p = String(apiKey || '').split('-');
  return p.length > 1 ? p[p.length - 1] : '';
}

async function chamarMailchimp({ apiKey, path, method = 'GET', body = null }) {
  const dc = dcDaChave(apiKey);
  if (!dc) throw new Error('Chave da API inválida — falta o sufixo do datacenter (ex: -us21).');
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from('anystring:' + apiKey).toString('base64'),
    },
  };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const resp = await fetch(`https://${dc}.api.mailchimp.com/3.0${path}`, opts);
  const texto = await resp.text();
  let data;
  try { data = texto ? JSON.parse(texto) : {}; } catch (_) { data = { raw: texto }; }
  return { status: resp.status, ok: resp.ok, data };
}

function erroMailchimp(r) {
  const d = r?.data || {};
  const detalhe = Array.isArray(d.errors) && d.errors.length
    ? d.errors.map(e => `${e.field}: ${e.message}`).join(' | ')
    : '';
  return [d.title, d.detail, detalhe].filter(Boolean).join(' — ') || `HTTP ${r?.status}`;
}

// Tags de segmentação: dá para filtrar a jornada por porte e solução lá dentro
function tagsDoLead(lead, cfg) {
  const t = [cfg.tag];
  if (lead.origem) t.push(`origem: ${lead.origem}`);
  if (lead.funcionarios) t.push(`porte: ${lead.funcionarios}`);
  if (lead.solucao) t.push(`solucao: ${lead.solucao}`);
  return t.filter(Boolean).slice(0, 8);
}

// Sobe (ou atualiza) o lead na audiência. O id do contato é o md5 do e-mail
// em minúsculo — é assim que o Mailchimp identifica, então repetir não duplica.
async function enviarLeadMailchimp(lead, cfgOpcional) {
  const cfg = cfgOpcional || await configMailchimp();
  if (!cfg.apiKey || !cfg.audienceId) return { pulou: 'não configurado' };

  const email = String(lead.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { pulou: 'sem e-mail válido' };

  const hash = crypto.createHash('md5').update(email).digest('hex');
  const nome = String(lead.nome || '').trim();
  const partes = nome.split(/\s+/);

  const corpo = {
    email_address: email,
    status_if_new: cfg.status,
    merge_fields: {
      FNAME: partes[0] || '',
      LNAME: partes.slice(1).join(' '),
      ...(lead.telefone ? { PHONE: String(lead.telefone) } : {}),
    },
    tags: tagsDoLead(lead, cfg),
  };

  const r = await chamarMailchimp({
    apiKey: cfg.apiKey,
    path: `/lists/${cfg.audienceId}/members/${hash}`,
    method: 'PUT',
    body: corpo,
  });

  if (!r.ok) {
    // Merge field que não existe na audiência não pode derrubar o cadastro
    if (r.status === 400 && JSON.stringify(r.data).includes('merge')) {
      const r2 = await chamarMailchimp({
        apiKey: cfg.apiKey,
        path: `/lists/${cfg.audienceId}/members/${hash}`,
        method: 'PUT',
        body: { email_address: email, status_if_new: cfg.status, tags: corpo.tags },
      });
      if (r2.ok) return { ok: true, id: hash, aviso: 'enviado sem os campos extras' };
      return { erro: erroMailchimp(r2) };
    }
    return { erro: erroMailchimp(r) };
  }

  // A tag precisa ser aplicada à parte para o Journey enxergar como "tag added"
  await chamarMailchimp({
    apiKey: cfg.apiKey,
    path: `/lists/${cfg.audienceId}/members/${hash}/tags`,
    method: 'POST',
    body: { tags: corpo.tags.map(name => ({ name, status: 'active' })) },
  });

  return { ok: true, id: hash };
}

// Tira o contato da régua quando ele vira cliente ou é perdido.
// NUNCA usa a exclusão definitiva do Mailchimp: e-mail apagado em definitivo
// não pode mais ser recadastrado, e um dia esse cliente pode precisar receber
// alguma coisa. Arquivar para de enviar e continua reversível.
async function sairDaReguaMailchimp(lead, cfg, motivo) {
  const email = String(lead.email || '').trim().toLowerCase();
  if (!email || !cfg.apiKey || !cfg.audienceId) return { pulou: 'sem e-mail ou sem configuração' };
  const hash = crypto.createHash('md5').update(email).digest('hex');
  const acao = cfg.aoConverter || 'arquivar';
  if (acao === 'nada') return { pulou: 'desligado na configuração' };

  // Desliga a tag da jornada e marca o que a pessoa virou
  const tags = [
    { name: cfg.tag, status: 'inactive' },
    { name: motivo === 'perdido' ? 'lead perdido' : 'cliente', status: 'active' },
  ];
  const rt = await chamarMailchimp({
    apiKey: cfg.apiKey,
    path: `/lists/${cfg.audienceId}/members/${hash}/tags`,
    method: 'POST',
    body: { tags },
  });

  if (acao === 'tags') return { ok: rt.ok, arquivado: false, erro: rt.ok ? '' : erroMailchimp(rt) };

  // DELETE aqui é ARQUIVAR no Mailchimp — reversível, para de enviar tudo.
  // A exclusão irreversível seria /actions/delete-permanent, que não usamos.
  const ra = await chamarMailchimp({
    apiKey: cfg.apiKey,
    path: `/lists/${cfg.audienceId}/members/${hash}`,
    method: 'DELETE',
  });
  return { ok: ra.ok || ra.status === 404, arquivado: true, erro: ra.ok ? '' : erroMailchimp(ra) };
}

async function registrarSyncMailchimp(leadId, resultado) {
  const dados = { mailchimpEm: new Date().toISOString() };
  if (resultado.ok) { dados.mailchimpId = resultado.id; dados.mailchimpErro = ''; }
  else if (resultado.erro) { dados.mailchimpErro = String(resultado.erro).slice(0, 300); }
  else return;
  try { await db.collection('leads').doc(leadId).set(dados, { merge: true }); } catch (_) {}
}

// ─── Lead novo entra na audiência sozinho ────────────────────────────────────
exports.mailchimpNovoLead = functions.firestore
  .document('leads/{id}')
  .onCreate(async snap => {
    try {
      const cfg = await configMailchimp();
      if (!cfg.ativo) return null;
      const lead = { id: snap.id, ...snap.data() };
      if (['convertido', 'perdido'].includes(lead.status)) return null;
      const r = await enviarLeadMailchimp(lead, cfg);
      if (r.pulou) { console.log('[mailchimp] pulou', snap.id, '-', r.pulou); return null; }
      await registrarSyncMailchimp(snap.id, r);
      console.log(`[mailchimp] ${lead.nome || snap.id}: ${r.ok ? 'na audiência' : 'ERRO ' + r.erro}`);
    } catch (e) {
      console.error('[mailchimp] onCreate:', e.message);
    }
    return null;
  });

// ─── Lead que ganhou e-mail depois também entra ──────────────────────────────
// O contato do WhatsApp entra sem e-mail e só recebe o endereço quando o
// formulário da Meta chega. Sem isto, ele nunca iria para a audiência.
exports.mailchimpLeadAtualizado = functions.firestore
  .document('leads/{id}')
  .onUpdate(async change => {
    try {
      const antes = change.before.data() || {};
      const depois = change.after.data() || {};
      const emailNovo = String(depois.email || '').trim().toLowerCase();
      const emailAntigo = String(antes.email || '').trim().toLowerCase();

      // Virou cliente ou foi perdido: sai da régua para não receber oferta
      const saiu = ['convertido', 'perdido'].includes(depois.status) && antes.status !== depois.status;
      if (saiu) {
        const cfgS = await configMailchimp();
        if (!cfgS.ativo) return null;
        const r = await sairDaReguaMailchimp({ ...depois, id: change.after.id }, cfgS, depois.status);
        if (!r.pulou) {
          await db.collection('leads').doc(change.after.id).set({
            mailchimpForaDaRegua: true,
            mailchimpForaDaReguaEm: new Date().toISOString(),
            mailchimpErro: r.erro || '',
          }, { merge: true });
          console.log(`[mailchimp] ${depois.nome || change.after.id} saiu da régua (${depois.status}): ${r.ok ? 'ok' : r.erro}`);
        }
        return null;
      }

      if (!emailNovo || emailNovo === emailAntigo) return null;   // e-mail não mudou
      if (depois.mailchimpId && emailNovo === emailAntigo) return null;

      const cfg = await configMailchimp();
      if (!cfg.ativo) return null;
      const r = await enviarLeadMailchimp({ id: change.after.id, ...depois }, cfg);
      if (r.pulou) return null;
      await registrarSyncMailchimp(change.after.id, r);
      console.log(`[mailchimp] atualizado ${depois.nome || change.after.id}: ${r.ok ? 'ok' : r.erro}`);
    } catch (e) {
      console.error('[mailchimp] onUpdate:', e.message);
    }
    return null;
  });

// ─── Testar conexão e listar audiências ──────────────────────────────────────
exports.mailchimpProxy = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const { acao = 'testar', apiKey: chaveAvulsa = '', audienceId = '' } = req.body || {};
    const cfg = await configMailchimp();
    const apiKey = chaveAvulsa || cfg.apiKey;
    if (!apiKey) throw new Error('Informe a chave da API do Mailchimp.');

    if (acao === 'testar') {
      const r = await chamarMailchimp({ apiKey, path: '/ping' });
      if (!r.ok) throw new Error(erroMailchimp(r));
      const l = await chamarMailchimp({ apiKey, path: '/lists?count=100&fields=lists.id,lists.name,lists.stats.member_count' });
      res.status(200).json({
        ok: true,
        saude: r.data?.health_status || 'ok',
        audiencias: (l.data?.lists || []).map(x => ({ id: x.id, nome: x.name, membros: x.stats?.member_count ?? 0 })),
      });
      return;
    }

    if (acao === 'jornadas') {
      // Lista as jornadas para você conferir qual está ligada na tag
      const r = await chamarMailchimp({ apiKey, path: '/customer-journeys/journeys?count=50' });
      res.status(r.ok ? 200 : r.status).json(r.ok ? { ok: true, jornadas: r.data } : { error: erroMailchimp(r) });
      return;
    }

    if (acao === 'enviarLead') {
      // Reenvio de um lead só, usado pelo botão da ficha quando deu erro
      const { leadId } = req.body || {};
      if (!leadId) throw new Error('Informe o lead.');
      const d = await db.collection('leads').doc(leadId).get();
      if (!d.exists) throw new Error('Lead não encontrado.');
      const r = await enviarLeadMailchimp({ id: d.id, ...d.data() }, { ...cfg, apiKey });
      if (r.pulou) { res.status(200).json({ ok: false, motivo: r.pulou }); return; }
      await registrarSyncMailchimp(leadId, r);
      if (r.erro) { res.status(200).json({ ok: false, motivo: r.erro }); return; }
      res.status(200).json({ ok: true, aviso: r.aviso || '' });
      return;
    }

    if (acao === 'sincronizar') {
      // Sobe de uma vez os leads que já estão na base
      const lista = audienceId ? { ...cfg, apiKey, audienceId } : { ...cfg, apiKey };
      if (!lista.audienceId) throw new Error('Escolha a audiência antes de sincronizar.');
      const snap = await db.collection('leads').get();
      let enviados = 0, pulados = 0, falhas = 0;
      const erros = [];
      for (const d of snap.docs) {
        const lead = { id: d.id, ...d.data() };
        // Quem já virou cliente ou foi perdido não volta para a régua
        if (['convertido', 'perdido'].includes(lead.status) || lead.mailchimpForaDaRegua) { pulados++; continue; }
        const r = await enviarLeadMailchimp(lead, lista);
        if (r.pulou) { pulados++; continue; }
        if (r.ok) { enviados++; await registrarSyncMailchimp(d.id, r); }
        else { falhas++; erros.push(`${lead.nome || d.id}: ${r.erro}`); await registrarSyncMailchimp(d.id, r); }
        await new Promise(x => setTimeout(x, 120));   // respiro para não tomar rate limit
      }
      await db.collection('sync_log').add({
        tipo: 'mailchimp', enviados, pulados, falhas,
        erros: erros.slice(0, 20), data: new Date().toISOString(),
      });
      res.status(200).json({ ok: true, enviados, pulados, falhas, erros: erros.slice(0, 10) });
      return;
    }

    throw new Error('Ação desconhecida: ' + acao);
  } catch (err) {
    console.error('[mailchimp] proxy:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// RAIO-X DO SISTEMA — relatório com leitura de IA, por WhatsApp
//
// Roda no horário configurado, levanta os números de verdade das coleções e
// entrega para a OpenAI comentar. A IA NÃO consulta nada e NÃO inventa: ela
// recebe os números já apurados e só interpreta — destaque, alerta e dica.
//
// Config em config/raiox:
//   ativo, frequencia (diario|dias_uteis|semanal), horario, diaSemana
//   destinatarios [ids de usuarios], finalidade (número do WhatsApp)
//   secoes {leads, comercial, implantacao, suporte, automacoes, qualidade}
//   instrucaoExtra (o que você quer que a IA olhe com atenção)
// ═══════════════════════════════════════════════════════════════════════════

// Tom de voz das mensagens automáticas. Global, com padrão sensato.
async function tomDeVoz() {
  try {
    const s = await db.collection('config').doc('mensagens').get();
    const d = s.exists ? s.data() : {};
    return d.tomDeVoz || 'Profissional e amigável. Direto, cordial, sem formalidade excessiva e sem parecer texto de robô.';
  } catch (_) {
    return 'Profissional e amigável.';
  }
}

async function configRaioX() {
  const snap = await db.collection('config').doc('raiox').get();
  const d = snap.exists ? snap.data() : {};
  return {
    ativo: d.ativo === true,
    frequencia: d.frequencia || 'dias_uteis',
    horario: d.horario || '18:00',
    diaSemana: Number(d.diaSemana ?? 1),
    destinatarios: Array.isArray(d.destinatarios) ? d.destinatarios : [],
    finalidade: d.finalidade || 'interno',
    numeroId: d.numeroId || null,
    secoes: {
      leads: true, comercial: true, implantacao: true,
      suporte: true, automacoes: true, qualidade: true,
      ...(d.secoes || {}),
    },
    instrucaoExtra: d.instrucaoExtra || '',
    ultimoEnvioEm: d.ultimoEnvioEm || '',
  };
}

const DIA_MS = 86400000;
function ehHoje(iso, ref) {
  if (!iso) return false;
  return String(iso).slice(0, 10) === ref;
}
function diasDesde(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / DIA_MS);
}

// Levanta os números do dia. Tudo aqui é contagem real, sem opinião.
async function coletarRaioX(cfg) {
  const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const hoje = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}-${String(agora.getDate()).padStart(2, '0')}`;

  const [leadSnap, cliSnap, implSnap, solSnap, usuSnap, campSnap, gatSnap] = await Promise.all([
    db.collection('leads').get(),
    db.collection('clientes').get(),
    db.collection('implantacoes').get(),
    db.collection('solicitacoes').get(),
    db.collection('usuarios').get(),
    db.collection('campanhas').get(),
    db.collection('gatilhos_log').get(),
  ]);
  const arr = s => { const a = []; s.forEach(d => a.push({ id: d.id, ...d.data() })); return a; };
  const leads = arr(leadSnap), clientes = arr(cliSnap), impl = arr(implSnap);
  const sols = arr(solSnap), usuarios = arr(usuSnap), camps = arr(campSnap);
  const logs = arr(gatSnap);

  const dados = { data: hoje };
  const nomeUsu = id => (usuarios.find(u => u.id === id) || {}).nome || '';

  if (cfg.secoes.leads) {
    const doDia = leads.filter(l => ehHoje(l.criadoEm, hoje));
    const semDono = leads.filter(l => !l.responsavelId);
    const parados = leads.filter(l => {
      const d = diasDesde(l.etapaEm || l.criadoEm);
      return d !== null && d >= 3 && !['convertido', 'perdido'].includes(l.status);
    });
    const porOrigem = {};
    doDia.forEach(l => { const o = l.origem || 'Sem origem'; porOrigem[o] = (porOrigem[o] || 0) + 1; });
    const porResponsavel = {};
    leads.filter(l => l.responsavelId).forEach(l => {
      const n = l.responsavelNome || nomeUsu(l.responsavelId) || '—';
      porResponsavel[n] = (porResponsavel[n] || 0) + 1;
    });
    dados.leads = {
      total_na_base: leads.length,
      novos_hoje: doDia.length,
      novos_hoje_por_origem: porOrigem,
      sem_responsavel: semDono.length,
      sem_responsavel_ha_mais_de_1_dia: semDono.filter(l => (diasDesde(l.criadoEm) || 0) >= 1).length,
      parados_3_dias_ou_mais: parados.length,
      carteira_por_vendedor: porResponsavel,
      convertidos_hoje: leads.filter(l => l.status === 'convertido' && ehHoje(l.atualizadoEm, hoje)).length,
      perdidos_hoje: leads.filter(l => l.status === 'perdido' && ehHoje(l.atualizadoEm, hoje)).length,
      reunioes_marcadas_hoje: leads.filter(l => l.apresData === hoje).length,
    };
  }

  if (cfg.secoes.comercial) {
    const novosHoje = clientes.filter(c => ehHoje(c.criadoEm, hoje));
    const fatHoje = clientes.filter(c => c.status === 'Faturado' && ehHoje(c.atualizadoEm, hoje));
    const soma = (l, k) => l.reduce((s, c) => s + (Number(c[k]) || 0), 0);
    const porVendedor = {};
    novosHoje.forEach(c => { const v = c.vendedor || '—'; porVendedor[v] = (porVendedor[v] || 0) + 1; });
    dados.comercial = {
      clientes_na_base: clientes.length,
      novos_clientes_hoje: novosHoje.length,
      novos_clientes_hoje_por_vendedor: porVendedor,
      valor_total_dos_novos_hoje: soma(novosHoje, 'total'),
      faturados_hoje: fatHoje.length,
      valor_faturado_hoje: soma(fatHoje, 'total'),
      aguardando_faturamento: clientes.filter(c => ['Aguardando', 'Boletos emitidos', 'Links enviados'].includes(c.status)).length,
      inadimplentes: clientes.filter(c => c.status === 'Inadimplente').length,
      faturado_parcial: clientes.filter(c => c.status === 'Faturado parcial').length,
      cancelados_no_mes: clientes.filter(c => c.status === 'Cancelado' && String(c.atualizadoEm || '').slice(0, 7) === hoje.slice(0, 7)).length,
    };
  }

  if (cfg.secoes.implantacao) {
    const atrasadas = impl.filter(i => i.prazo && i.prazo < hoje && i.etapa !== 'processo_finalizado');
    const paradas = impl.filter(i => {
      const d = diasDesde(i.etapaData);
      return d !== null && d >= 7 && i.etapa !== 'processo_finalizado';
    });
    const porEtapa = {};
    impl.filter(i => i.etapa !== 'processo_finalizado').forEach(i => {
      porEtapa[i.etapa || 'sem etapa'] = (porEtapa[i.etapa || 'sem etapa'] || 0) + 1;
    });
    dados.implantacao = {
      em_andamento: impl.filter(i => i.etapa !== 'processo_finalizado').length,
      por_etapa: porEtapa,
      atrasadas: atrasadas.length,
      nomes_das_atrasadas: atrasadas.slice(0, 5).map(i => i.clienteNome || i.id),
      paradas_7_dias_ou_mais: paradas.length,
      sem_prazo: impl.filter(i => !i.prazo && i.etapa !== 'processo_finalizado').length,
      sem_responsavel: impl.filter(i => !i.responsavelId && i.etapa !== 'processo_finalizado').length,
    };
  }

  if (cfg.secoes.suporte) {
    const abertas = sols.filter(s => s.status !== 'Concluída' && s.status !== 'Cancelada');
    const porPrior = {};
    abertas.forEach(s => { porPrior[s.prioridade || '—'] = (porPrior[s.prioridade || '—'] || 0) + 1; });
    dados.suporte = {
      abertas: abertas.length,
      abertas_hoje: sols.filter(s => ehHoje(s.criadoEm, hoje)).length,
      concluidas_hoje: sols.filter(s => s.status === 'Concluída' && ehHoje(s.atualizadoEm, hoje)).length,
      por_prioridade: porPrior,
      sem_responsavel: abertas.filter(s => !s.responsavelId).length,
      abertas_ha_mais_de_5_dias: abertas.filter(s => (diasDesde(s.criadoEm) || 0) >= 5).length,
    };
  }

  if (cfg.secoes.automacoes) {
    const logHoje = logs.filter(l => ehHoje(l.data, hoje));
    const campAtivas = camps.filter(c => c.status === 'enviando' || c.status === 'agendada');
    dados.automacoes = {
      mensagens_automaticas_hoje: logHoje.length,
      falhas_de_envio_hoje: logHoje.filter(l => !l.sucesso).length,
      exemplos_de_falha: logHoje.filter(l => !l.sucesso).slice(0, 3).map(l => `${l.gatilhoNome || l.evento}: ${String(l.erro || '').slice(0, 90)}`),
      campanhas_em_andamento: campAtivas.length,
      campanhas_com_falha: camps.filter(c => (c.falhas || 0) > 0).map(c => ({ nome: c.nome, enviados: c.enviados || 0, falhas: c.falhas })).slice(0, 5),
      leads_com_erro_no_mailchimp: leads.filter(l => l.mailchimpErro).length,
    };
  }

  if (cfg.secoes.qualidade) {
    dados.qualidade_do_cadastro = {
      leads_sem_telefone: leads.filter(l => !l.telefone).length,
      leads_sem_email: leads.filter(l => !l.email).length,
      leads_sem_porte_informado: leads.filter(l => !l.funcionarios).length,
      clientes_sem_cnpj: clientes.filter(c => !c.cnpj).length,
      usuarios_sem_celular: usuarios.filter(u => u.status !== 'revogado' && !u.celular).map(u => u.nome || u.email),
      usuarios_sem_sala_de_reuniao: usuarios.filter(u => u.status !== 'revogado' && !u.salaReuniao).map(u => u.nome || u.email),
      possiveis_leads_duplicados: (() => {
        const porTel = {};
        leads.forEach(l => {
          const t = String(l.telefone || '').replace(/\D/g, '').slice(-8);
          if (t) porTel[t] = (porTel[t] || 0) + 1;
        });
        return Object.values(porTel).filter(n => n > 1).length;
      })(),
    };
  }

  return dados;
}

// A IA recebe os números prontos e só interpreta
async function comentarRaioX(dados, cfg, destinatario) {
  if (!OPENAI_KEY) return null;

  const sistema = [
    'Você é o analista de dados da Guion Informática, revenda Secullum de sistemas de controle de ponto.',
    'Recebe os números reais do CRM de hoje e escreve um raio-x curto no WhatsApp para o time.',
    '',
    'REGRAS DE CONTEÚDO',
    '- Use APENAS os números que estão no JSON. Nunca invente, estime nem projete.',
    '- Se um número for zero ou o dado não existir, simplesmente não fale dele.',
    '- Vá do mais importante para o menos. O que exige ação hoje vem primeiro.',
    '- Compare e relacione: lead sem responsável parado há dias é mais grave que lead novo sem responsável.',
    '- Aponte causa provável quando os números sugerirem, mas deixe claro que é leitura sua.',
    '',
    'FORMATO (WhatsApp, não markdown)',
    '- Negrito com *asterisco simples*. Nunca use #, ## nem tabelas.',
    '- Comece com uma linha de título com a data.',
    '- Depois, no máximo 4 blocos curtos. Cada bloco: um título em negrito e 2 a 4 linhas.',
    '- Use no máximo 5 emojis na mensagem inteira, sempre no começo da linha.',
    '- Termine com *O que eu faria hoje* e 2 ou 3 ações concretas, na ordem de prioridade.',
    '- No máximo 20 linhas no total. Se sobrar assunto, corte o menos importante.',
    '- Escreva como um colega analisando o dia, não como relatório corporativo.',
    cfg.instrucaoExtra ? `\nORIENTAÇÃO DA CASA\n${cfg.instrucaoExtra}` : '',
  ].filter(Boolean).join('\n');

  const pedido = [
    destinatario ? `Este relatório vai para ${destinatario}.` : '',
    'Números de hoje:',
    '```json',
    JSON.stringify(dados, null, 1),
    '```',
  ].filter(Boolean).join('\n');

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o', max_tokens: 900, temperature: 0.6,
        messages: [{ role: 'system', content: sistema }, { role: 'user', content: pedido }],
      }),
    });
    const data = await resp.json();
    if (!resp.ok) { console.error('[raiox] OpenAI:', data?.error?.message); return null; }
    return (data.choices?.[0]?.message?.content || '').trim();
  } catch (e) {
    console.error('[raiox] erro IA:', e.message);
    return null;
  }
}

// Texto de reserva, caso a IA não responda: os números crus, sem leitura
function raioXSemIA(dados) {
  const l = [`📊 *Raio-x do sistema* — ${new Date(dados.data + 'T12:00:00').toLocaleDateString('pt-BR')}`, ''];
  const bloco = (titulo, obj) => {
    if (!obj) return;
    const linhas = Object.entries(obj)
      .filter(([, v]) => v && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length))
      .map(([k, v]) => `• ${k.replace(/_/g, ' ')}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? Object.entries(v).map(([a, b]) => `${a} ${b}`).join(', ') : v}`);
    if (linhas.length) l.push(`*${titulo}*`, ...linhas.slice(0, 8), '');
  };
  bloco('Leads', dados.leads);
  bloco('Comercial', dados.comercial);
  bloco('Implantação', dados.implantacao);
  bloco('Suporte', dados.suporte);
  bloco('Automações', dados.automacoes);
  bloco('Qualidade do cadastro', dados.qualidade_do_cadastro);
  return l.join('\n').trim();
}

async function gerarEEnviarRaioX({ apenasGerar, paraUsuarioId } = {}) {
  const cfg = await configRaioX();
  const dados = await coletarRaioX(cfg);

  const usnap = await db.collection('usuarios').get();
  const usuarios = [];
  usnap.forEach(d => usuarios.push({ id: d.id, ...d.data() }));

  const alvos = (paraUsuarioId ? [paraUsuarioId] : cfg.destinatarios)
    .map(id => usuarios.find(u => u.id === id))
    .filter(u => u && u.celular && u.status !== 'revogado');

  const texto = (await comentarRaioX(dados, cfg, alvos[0]?.nome?.split(' ')[0])) || raioXSemIA(dados);

  if (apenasGerar) return { texto, dados, destinatarios: alvos.map(u => u.nome || u.email) };

  if (!alvos.length) {
    console.log('[raiox] nenhum destinatário com celular cadastrado');
    return { texto, enviados: 0, motivo: 'sem destinatário' };
  }

  let enviados = 0;
  for (const u of alvos) {
    try {
      const numero = await obterNumeroDatafy({ numeroId: cfg.numeroId, finalidade: cfg.finalidade });
      const r = await chamarDatafy({
        token: numero.token, path: '/messages/send/text',
        method: 'POST', body: { to: normalizarNumero(u.celular), text: texto },
      });
      await db.collection('gatilhos_log').add({
        gatilhoNome: 'Raio-x do sistema', evento: 'raiox',
        destinatario: u.nome || u.email, destino: normalizarNumero(u.celular),
        mensagem: texto.slice(0, 500), comIA: true, sucesso: r.ok,
        erro: r.ok ? '' : JSON.stringify(r.data).slice(0, 300),
        data: new Date().toISOString(),
      });
      if (r.ok) enviados++;
    } catch (e) {
      console.error('[raiox] envio para', u.nome, ':', e.message);
    }
  }
  return { texto, enviados, total: alvos.length };
}

// ─── Execução agendada ───────────────────────────────────────────────────────
exports.raioXAgendado = functions.runWith({ timeoutSeconds: 300 }).pubsub
  .schedule('every 15 minutes')
  .timeZone('America/Sao_Paulo')
  .onRun(async () => {
    try {
      const cfg = await configRaioX();
      if (!cfg.ativo) return null;

      const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
      const hoje = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}-${String(agora.getDate()).padStart(2, '0')}`;
      const dia = agora.getDay();

      if (cfg.frequencia === 'dias_uteis' && (dia === 0 || dia === 6)) return null;
      if (cfg.frequencia === 'semanal' && dia !== cfg.diaSemana) return null;
      if ((cfg.ultimoEnvioEm || '').slice(0, 10) === hoje) return null;   // uma vez por dia

      const minutos = t => { const [h, m] = String(t).split(':'); return (+h || 0) * 60 + (+m || 0); };
      const atraso = (agora.getHours() * 60 + agora.getMinutes()) - minutos(cfg.horario);
      if (atraso < 0 || atraso > 60) return null;   // janela de 1h após o horário

      await db.collection('config').doc('raiox').set({ ultimoEnvioEm: new Date().toISOString() }, { merge: true });
      const r = await gerarEEnviarRaioX();
      console.log(`[raiox] enviado para ${r.enviados}/${r.total || 0}`);
    } catch (e) {
      console.error('[raiox] erro geral:', e.message, e.stack);
    }
    return null;
  });

// ─── Gerar agora (prévia ou envio manual) ────────────────────────────────────
exports.raioXAgora = functions.runWith({ timeoutSeconds: 300 })
  .https.onRequest(async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    try {
      const { apenasGerar = true, paraUsuarioId = null } = req.body || {};
      const r = await gerarEEnviarRaioX({ apenasGerar, paraUsuarioId });
      res.status(200).json({ ok: true, ...r });
    } catch (err) {
      console.error('[raiox] agora:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

// ═══════════════════════════════════════════════════════════════════════════
// LIMPEZA DE LEADS — junta duplicados e recolhe os contatos sem qualificação
//
// Sempre roda em duas etapas. Primeiro só analisa e devolve o que PRETENDE
// fazer; nada é apagado enquanto você não confirmar. Apagar cadastro sem
// prévia é o tipo de coisa que não tem desfazer.
//
// Duplicado é decidido pelos 8 últimos dígitos do telefone — é o que sobrevive
// às diferenças de formato (+55, sem +55, com e sem máscara).
// ═══════════════════════════════════════════════════════════════════════════

function chaveTelefone(tel) {
  const n = String(tel || '').replace(/\D/g, '');
  return n.length >= 8 ? n.slice(-8) : '';
}

// Quanto mais campo preenchido, mais "completo" o cadastro. O vencedor de cada
// grupo é o mais completo; havendo empate, o mais antigo.
function pontuarLead(l) {
  let p = 0;
  if (l.email) p += 3;
  if (l.funcionarios) p += 2;
  if (l.solucao) p += 2;
  if (l.sistema_ponto) p += 1;
  if (l.responsavelId) p += 4;          // já tem dono: nunca descartar
  if (l.leadgenId) p += 2;              // veio do formulário do anúncio
  if ((l.conversa || []).length) p += 2;
  if ((l.historico || []).length) p += 1;
  if (l.apresData) p += 3;              // tem reunião marcada
  if (l.status && l.status !== 'novo') p += 2;
  if (l.nome && !/^(CONTATO WHATSAPP|SEM NOME)$/i.test(l.nome)) p += 1;
  return p;
}

// Junta os dois cadastros: o vencedor recebe o que só existia no perdedor
function fundirLeads(vencedor, perdedor) {
  const dados = {};
  const campos = ['email', 'telefone', 'funcionarios', 'solucao', 'sistema_ponto',
    'origem', 'campanha', 'conjunto', 'anuncio', 'formulario', 'plataforma',
    'leadgenId', 'responsavelId', 'responsavelNome', 'apresData', 'apresHora',
    'apresResponsavelId', 'apresResponsavelNome', 'apresLocal', 'apresObs'];
  campos.forEach(k => { if (!vencedor[k] && perdedor[k]) dados[k] = perdedor[k]; });

  const conv = [...(vencedor.conversa || []), ...(perdedor.conversa || [])]
    .sort((a, b) => new Date(a.data || 0) - new Date(b.data || 0));
  if (conv.length > (vencedor.conversa || []).length) dados.conversa = conv.slice(-100);

  const hist = [...(vencedor.historico || []), ...(perdedor.historico || [])]
    .sort((a, b) => new Date(a.data || 0) - new Date(b.data || 0));
  if (hist.length > (vencedor.historico || []).length) dados.historico = hist.slice(-100);

  // Nome de perfil do WhatsApp perde para nome vindo do formulário
  const ruim = n => !n || /^(CONTATO WHATSAPP|SEM NOME)$/i.test(n);
  if (ruim(vencedor.nome) && !ruim(perdedor.nome)) dados.nome = perdedor.nome;

  if (perdedor.criadoEm && (!vencedor.criadoEm || perdedor.criadoEm < vencedor.criadoEm)) {
    dados.criadoEm = perdedor.criadoEm;
  }
  return dados;
}

async function analisarLimpeza() {
  const snap = await db.collection('leads').get();
  const leads = [];
  snap.forEach(d => leads.push({ id: d.id, ...d.data() }));

  // ── Duplicados por telefone ──────────────────────────────────────────────
  const porTel = {};
  leads.forEach(l => {
    const k = chaveTelefone(l.telefone);
    if (!k) return;
    (porTel[k] = porTel[k] || []).push(l);
  });

  const fusoes = [];
  Object.entries(porTel).forEach(([tel, grupo]) => {
    if (grupo.length < 2) return;
    const ordenado = [...grupo].sort((a, b) => {
      const d = pontuarLead(b) - pontuarLead(a);
      if (d !== 0) return d;
      return String(a.criadoEm || '').localeCompare(String(b.criadoEm || ''));
    });
    const [vencedor, ...perdedores] = ordenado;
    fusoes.push({
      telefone: tel,
      manter: { id: vencedor.id, nome: vencedor.nome || '', email: vencedor.email || '', pontos: pontuarLead(vencedor) },
      remover: perdedores.map(p => ({ id: p.id, nome: p.nome || '', email: p.email || '', pontos: pontuarLead(p) })),
    });
  });

  // ── Contatos que nunca deveriam ter virado lead ──────────────────────────
  // Sem e-mail, sem porte, sem solução, sem dono e sem conversa: é o cadastro
  // que o webhook antigo criava a partir de qualquer mensagem recebida.
  const idsEmFusao = new Set(fusoes.flatMap(f => f.remover.map(r => r.id)));
  const semQualificacao = leads.filter(l =>
    !idsEmFusao.has(l.id) &&
    !l.email && !l.funcionarios && !l.solucao &&
    !l.responsavelId && !l.leadgenId &&
    !(l.conversa || []).length &&
    (l.origem === 'WhatsApp' || /^(CONTATO WHATSAPP|SEM NOME)$/i.test(l.nome || ''))
  ).map(l => ({ id: l.id, nome: l.nome || '', telefone: l.telefone || '', criadoEm: l.criadoEm || '' }));

  return {
    total_de_leads: leads.length,
    grupos_duplicados: fusoes.length,
    leads_que_serao_removidos_por_duplicidade: fusoes.reduce((s, f) => s + f.remover.length, 0),
    contatos_sem_qualificacao: semQualificacao.length,
    fusoes,
    semQualificacao,
  };
}

exports.limparLeads = functions.runWith({ timeoutSeconds: 540 })
  .https.onRequest(async (req, res) => {
    setCors(req, res);
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    try {
      const { confirmar = false, removerSemQualificacao = false } = req.body || {};
      const plano = await analisarLimpeza();

      if (!confirmar) {
        res.status(200).json({ ok: true, previa: true, ...plano });
        return;
      }

      const snap = await db.collection('leads').get();
      const mapa = {};
      snap.forEach(d => { mapa[d.id] = { id: d.id, ...d.data() }; });

      let fundidos = 0, removidos = 0;

      for (const f of plano.fusoes) {
        const vencedor = mapa[f.manter.id];
        if (!vencedor) continue;
        for (const r of f.remover) {
          const perdedor = mapa[r.id];
          if (!perdedor) continue;
          const dados = fundirLeads(vencedor, perdedor);
          if (Object.keys(dados).length) {
            await db.collection('leads').doc(vencedor.id).set(dados, { merge: true });
            Object.assign(vencedor, dados);
          }
          await db.collection('leads_removidos').doc(perdedor.id).set({
            ...perdedor, motivo: 'duplicado', fundidoEm: vencedor.id,
            removidoEm: new Date().toISOString(),
          });
          await db.collection('leads').doc(perdedor.id).delete();
          removidos++;
        }
        fundidos++;
      }

      if (removerSemQualificacao) {
        for (const s of plano.semQualificacao) {
          const l = mapa[s.id];
          if (!l) continue;
          await db.collection('leads_removidos').doc(l.id).set({
            ...l, motivo: 'sem qualificação', removidoEm: new Date().toISOString(),
          });
          await db.collection('leads').doc(l.id).delete();
          removidos++;
        }
      }

      await db.collection('sync_log').add({
        tipo: 'limpeza_leads', fundidos, removidos,
        data: new Date().toISOString(),
      });

      res.status(200).json({ ok: true, fundidos, removidos });
    } catch (err) {
      console.error('[limpeza] erro:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

// ═══════════════════════════════════════════════════════════════════════════
// CANAL QR CODE — WhatsApp conectado por leitura de código
//
// Segundo caminho de envio, ao lado da API oficial. Serve para falar com quem
// está FORA da janela de 24 horas sem depender de template aprovado.
//
// ╔═ O QUE VOCÊ PRECISA SABER ═══════════════════════════════════════════════
// Conexão por QR é API NÃO OFICIAL: a ferramenta se passa por WhatsApp Web.
// Isso contraria os termos de uso do WhatsApp e o número PODE SER BANIDO.
// Use sempre um chip dedicado, nunca o número comercial nem o pessoal.
// O que mais derruba número não é velocidade: é falar com muita gente que
// nunca falou com você, ter pouca resposta e receber bloqueio ou denúncia.
// ══════════════════════════════════════════════════════════════════════════
//
// Não fixamos um fornecedor. Em config_whatsapp, o número com tipo 'qr' guarda
// qual provedor usar, e cada um tem seu formato de chamada.

function montarChamadaQR(numero, destino, texto) {
  const prov = (numero.provedor || 'zapi').toLowerCase();
  const base = String(numero.baseUrl || '').replace(/\/+$/, '');
  const inst = numero.instancia || '';
  const tok = numero.token || '';

  if (prov === 'zapi') {
    return {
      url: `${base || 'https://api.z-api.io'}/instances/${inst}/token/${tok}/send-text`,
      headers: numero.clientToken ? { 'Client-Token': numero.clientToken } : {},
      body: { phone: destino, message: texto },
    };
  }
  if (prov === 'evolution') {
    return {
      url: `${base}/message/sendText/${inst}`,
      headers: { apikey: tok },
      body: { number: destino, text: texto },
    };
  }
  if (prov === 'zapster') {
    return {
      url: `${base || 'https://api.zapsterapi.com'}/v1/wa/messages`,
      headers: { Authorization: `Bearer ${tok}` },
      body: { instance_id: inst, recipient: destino, text: texto },
    };
  }
  // custom: o corpo vem de um modelo JSON com marcadores
  const modelo = numero.corpoModelo || '{"phone":"__DESTINO__","message":"__TEXTO__"}';
  let corpo;
  try {
    corpo = JSON.parse(
      modelo.replace(/__DESTINO__/g, destino).replace(/__TEXTO__/g, JSON.stringify(texto).slice(1, -1))
    );
  } catch (_) { corpo = { phone: destino, message: texto }; }
  let headers = {};
  try { headers = numero.headersExtras ? JSON.parse(numero.headersExtras) : {}; } catch (_) {}
  return { url: `${base}${numero.caminho || ''}`, headers, body: corpo };
}

async function enviarPorQR(numero, para, texto) {
  const destino = normalizarNumero(para);
  const { url, headers, body } = montarChamadaQR(numero, destino, texto);
  if (!url || /undefined|\/\/$/.test(url)) {
    return { ok: false, status: 0, data: { error: 'Configuração do provedor QR incompleta.' } };
  }
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const t = await resp.text();
    let data; try { data = t ? JSON.parse(t) : {}; } catch (_) { data = { raw: t }; }
    return { status: resp.status, ok: resp.ok, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: e.message } };
  }
}

// Ponto único de envio: escolhe o caminho pelo tipo do número cadastrado
async function enviarTextoWhats(numero, para, texto) {
  if ((numero.tipo || 'oficial') === 'qr') return enviarPorQR(numero, para, texto);
  return chamarDatafy({
    token: numero.token, path: '/messages/send/text',
    method: 'POST', body: { to: normalizarNumero(para), text: texto },
  });
}

// ─── PROTEÇÕES DO DISPARO POR QR ─────────────────────────────────────────────
// Nenhuma delas elimina o risco de banimento. Elas reduzem o padrão que o
// WhatsApp usa para identificar automação.

// Intervalo sorteado dentro de uma faixa. Ritmo exato é assinatura de robô:
// 30 segundos cravados entre cada envio é mais suspeito que 25 a 70 variando.
function intervaloSorteado(min, max) {
  const a = Math.max(5, Number(min) || 30);
  const b = Math.max(a, Number(max) || a * 2);
  return Math.round((a + Math.random() * (b - a)) * 1000);
}

// Aquecimento: número novo que dispara 200 mensagens no primeiro dia cai.
// A escada começa baixa e sobe conforme os dias de uso do chip.
function tetoDoDia(numero, limiteConfigurado) {
  const teto = Number(limiteConfigurado) || 100;
  const desde = numero.conectadoEm ? new Date(numero.conectadoEm).getTime() : null;
  if (!desde) return Math.min(teto, 20);
  const dias = Math.floor((Date.now() - desde) / 86400000);
  const escada = [20, 30, 50, 80, 120, 160, 200];
  const permitido = dias >= escada.length ? teto : escada[dias];
  return Math.min(teto, permitido);
}

function dentroDaJanela(inicio, fim) {
  const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dia = agora.getDay();
  if (dia === 0 || dia === 6) return false;                 // fim de semana fora
  const hm = `${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;
  return hm >= (inicio || '09:00') && hm <= (fim || '18:00');
}

// ─── TESTE DE CONEXÃO DO NÚMERO QR ───────────────────────────────────────────
exports.qrTestar = functions.https.onRequest(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  try {
    const { numero, para, texto } = req.body || {};
    if (!numero) throw new Error('Envie os dados do número.');
    if (!para) throw new Error('Informe um número de destino para o teste.');
    const r = await enviarPorQR(numero, para, texto || 'Teste de conexão do CRM Guion. Se você recebeu, está funcionando.');
    res.status(200).json({
      ok: r.ok,
      status: r.status,
      resposta: r.data,
      dica: r.ok ? '' : 'Confira o provedor, a instância e o token. Muitos provedores exigem que o QR esteja lido e a sessão conectada.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
