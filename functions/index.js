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
