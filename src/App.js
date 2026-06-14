import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  collection, doc, setDoc, getDocs, onSnapshot, deleteDoc
} from "firebase/firestore";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged
} from "firebase/auth";
import { db, auth } from "./firebase";

// --- CONSTANTES --------------------------------------------------------------
const MESES=["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
const PLANOS=['Basic','Pro','Ultimate'];
// Formas de pagamento espelhadas do Asaas
const FORMAS_ASAAS=['Boleto','Pix','Cartão'];
const FORMAS=FORMAS_ASAAS; // apenas formas que o Asaas suporta
const EQUIPS=['Evo40','Tablet','Celular','Control ID','TopData InnerRep','Já possui','Nenhum','Outro'];
// Status Asaas → badge visual
const ASAAS_STATUS={
  SEM_FATURAMENTO:{label:'Sem faturamento', color:'#3498db',   emoji:'🔵'},
  PENDING:         {label:'Pendente',        color:'#f5a623',   emoji:'🟡'},
  RECEIVED:        {label:'Em dia',          color:'#27ae60',   emoji:'🟢'},
  CONFIRMED:       {label:'Em dia',          color:'#27ae60',   emoji:'🟢'},
  OVERDUE:         {label:'Vencido',         color:'#e74c3c',   emoji:'🔴'},
  CANCELED:        {label:'Cancelado',       color:'#7f8c8d',   emoji:'⚫'},
};
const ETAPAS=[
  {id:'venda_fechada',      label:'Venda Fechada',          color:'#3498db'},
  {id:'aguardando_retorno', label:'Aguardando Retorno',     color:'#e67e22'},
  {id:'em_configuracao',    label:'Em Configuração',        color:'#9b59b6'},
  {id:'envio_correios',     label:'Envio Correios',         color:'#1abc9c'},
  {id:'implantacao_cliente',label:'Implantação no Cliente', color:'#e74c3c'},
  {id:'implantacao_final',  label:'Implantação Finalizada', color:'#27ae60'},
  {id:'agendado_treinamento',label:'Agendado Treinamento',  color:'#f39c12'},
  {id:'processo_finalizado',label:'Processo Finalizado',    color:'#2c3e50'},
];
const PERFIS={
  admin:      {label:'Acesso total',      desc:'Todos os dados e configurações', icon:'ti-shield-check', color:'#e74c3c'},
  financeiro: {label:'Acesso financeiro', desc:'Dados financeiros, totais e pendentes', icon:'ti-currency-dollar', color:'#27ae60'},
  colaborador:{label:'Colaborador',       desc:'Cadastro de clientes e implantação', icon:'ti-user', color:'#3498db'},
};
const NAV_ITEMS_BASE=[
  {id:'dashboard',     icon:'ti-layout-dashboard', label:'Dashboard',      perfis:['admin','financeiro','colaborador']},
  {id:'vendas',        icon:'ti-chart-bar',         label:'Vendas',         perfis:['admin','financeiro']},
  {id:'financeiro',    icon:'ti-currency-dollar',   label:'Financeiro',     perfis:['admin','financeiro']},
  {id:'asaas',         icon:'ti-building-bank',     label:'Asaas',          perfis:['admin','financeiro']},
  {id:'clientes',      icon:'ti-users',             label:'Clientes',       perfis:['admin','colaborador']},
  {id:'novo',          icon:'ti-plus',              label:'Novo cliente',   perfis:['admin','colaborador']},
  {id:'implantacao',   icon:'ti-rocket',            label:'Implantação',    perfis:['admin','colaborador']},
  {id:'relatorios',    icon:'ti-file-spreadsheet',  label:'Relatórios',     perfis:['admin','financeiro']},
  {id:'solicitacoes',  icon:'ti-message-circle',    label:'Solicitações',   perfis:['admin','financeiro','colaborador']},
  {id:'orcamentos',    icon:'ti-file-invoice',       label:'Orçamentos',     perfis:['admin','financeiro','colaborador']},
];
// Config sempre fixo no final, só admin
const NAV_CONFIG={id:'config',icon:'ti-settings',label:'Configurações',perfis:['admin']};
function getNavItems(order){
  const base=NAV_ITEMS_BASE.slice();
  if(!order||!order.length)return[...base,NAV_CONFIG];
  // Filtrar separadores para não aparecerem como itens de nav
  const ids=order.filter(id=>!id.startsWith('sep_'));
  const sorted=[...ids.map(id=>base.find(n=>n.id===id)).filter(Boolean),...base.filter(n=>!ids.includes(n.id))];
  return[...sorted,NAV_CONFIG];
}
function getSidebarItems(order,perfil){
  // Retorna itens + separadores para a sidebar
  const base=NAV_ITEMS_BASE.slice();
  if(!order||!order.length){
    return[...base.filter(n=>n.perfis.includes(perfil)),NAV_CONFIG];
  }
  const result=[];
  const usados=new Set();
  order.forEach(id=>{
    if(id.startsWith('sep_')){result.push({id,isSep:true});return;}
    const item=base.find(n=>n.id===id);
    if(item&&item.perfis.includes(perfil)){result.push(item);usados.add(id);}
  });
  base.filter(n=>!usados.has(n.id)&&n.perfis.includes(perfil)).forEach(n=>result.push(n));
  result.push(NAV_CONFIG);
  return result;
}
const NAV_ITEMS=getNavItems(null);
const C={
  sidebar:'#2c3e50',sidebarActive:'#f5a623',
  header:'#ffffff',
  blue:'#3498db',green:'#27ae60',orange:'#f5a623',red:'#e74c3c',
  purple:'#9b59b6',teal:'#1abc9c',
  bg:'#f5f6fa',card:'#ffffff',text:'#4a4a4a',textMuted:'#7f8c8d',border:'#e8eaed',
  accent:'#f5a623',accentLight:'#fff8ee',
};

// Status do cliente — automáticos baseados no processo
const STATUS_CLIENTE=[
  {id:'Novo',             label:'🆕 Novo',              color:'#95a5a6'},
  {id:'Links enviados',   label:'⚡ Links enviados',     color:'#3498db'},
  {id:'Aguardando',       label:'⏳ Aguard. boletos',    color:'#f5a623'},
  {id:'Faturado parcial', label:'💰 Faturado parcial',  color:'#f39c12'},
  {id:'Faturado',         label:'✅ Faturado',           color:'#27ae60'},
  {id:'Inadimplente',     label:'🔴 Inadimplente',      color:'#e74c3c'},
  {id:'Cancelado',        label:'⚫ Cancelado',          color:'#7f8c8d'},
];
function getStatusCliente(s){return STATUS_CLIENTE.find(x=>x.id===s)||STATUS_CLIENTE[0];}
function corStatus(s){return getStatusCliente(s).color;}
function labelStatus(s){return getStatusCliente(s).label;}

// --- HELPERS -----------------------------------------------------------------
function parseDate(s){
  if(!s)return null;
  s=String(s).trim();
  const m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if(m){const mes=+m[1]-1,dia=+m[2],ano=+m[3];
    if(ano>=2020&&ano<=2030&&mes>=0&&mes<=11&&dia>=1&&dia<=31)return new Date(ano,mes,dia);}
  return null;
}
function fmtDate(d){if(!d)return'';return`${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;}
function parseValor(s){
  if(s===null||s===undefined)return 0;
  s=String(s).trim();
  if(!s||['abonado','bonificado','sem valor','zerado','-'].some(x=>s.toLowerCase().includes(x)))return 0;
  // Remove R$ e espaços
  let limpo=s.replace(/R\$\s*/gi,'').replace(/\s/g,'').trim();
  // Formato BR com vírgula decimal (ex: 1.450,00 ou 69,90): remove pontos de milhar e troca vírgula por ponto
  if(limpo.includes(','))limpo=limpo.replace(/\./g,'').replace(',','.');
  // Senão já é formato numérico normal (ex: 89.9, 1450, 69.90)
  const n=parseFloat(limpo);
  if(isNaN(n)||n<0)return 0;
  return n;
}
function moeda(v){return(+v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});}
function getDataTs(c){
  if(!c.data)return 0;
  if(c.data instanceof Date)return c.data.getTime()||0;
  // Firebase Timestamp {seconds, nanoseconds}
  if(c.data.seconds)return c.data.seconds*1000;
  // ISO string ou outro formato
  const d=new Date(c.data);
  return isNaN(d.getTime())?0:d.getTime();
}

// --- MÁSCARA TELEFONE --------------------------------------------------------
function mascaraTel(v){
  // Remove tudo que não for número
  const n=v.replace(/\D/g,'').slice(0,11);
  if(n.length<=2) return n.length?'('+n:'';
  if(n.length<=6) return '('+n.slice(0,2)+') '+n.slice(2);
  if(n.length<=10) return '('+n.slice(0,2)+') '+n.slice(2,6)+'-'+n.slice(6);
  return '('+n.slice(0,2)+') '+n.slice(2,7)+'-'+n.slice(7);
}
function telParaWa(tel){
  // Remove tudo que não for número e adiciona código do Brasil
  const n=tel.replace(/\D/g,'');
  if(!n) return '';
  // Se começar com 0 remove
  const limpo=n.startsWith('0')?n.slice(1):n;
  return '55'+limpo;
}

function sortRecente(arr){
  return [...arr].sort((a,b)=>getDataTs(b)-getDataTs(a));
}


// --- EXPORT EXCEL/CSV --------------------------------------------------------
function exportarExcel(dados, nomeArquivo){
  const escape=v=>{
    if(v==null)return'';
    const s=String(v);
    if(s.includes(';')||s.includes('"')||s.includes('\n'))return`"${s.replace(/"/g,'""')}"`;
    return s;
  };
  const cab=['Data','Empresa','CNPJ','Contato','Telefone','Email','Funcionários','Equipamento','Plano','Vendedor','Status','Sistema/mês','Implantação','Equipamento R$','Total','Pagamento','1º Boleto'];
  const linhas=[cab,...dados.map(c=>{
    let dataFmt='';
    try{
      const d=c.data instanceof Date?c.data:(c.data?new Date(c.data):null);
      if(d&&!isNaN(d))dataFmt=`${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
    }catch(e){}
    return[dataFmt,c.nome,c.cnpj,c.contato,c.tel,c.email,c.func,c.equipTipo,c.plano,c.vendedor,c.status,
      (c.vS||0).toFixed(2),(c.vI||0).toFixed(2),(c.vE||0).toFixed(2),(c.total||0).toFixed(2),c.pagamento,c.dtBoleto];
  })];
  const csv='\uFEFF'+linhas.map(l=>l.map(escape).join(';')).join('\n');
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=nomeArquivo+'.csv';a.click();
  URL.revokeObjectURL(url);
}

// --- GRÁFICO MRR MENSAL ------------------------------------------------------
function GraficoMRR({todos}){
  const anoAtual=new Date().getFullYear();
  const anos=[...new Set(todos.map(c=>c.ano).filter(Boolean))].sort();
  const [anoSel,setAnoSel]=useState(anos.includes(anoAtual)?anoAtual:(anos[anos.length-1]||anoAtual));
  const mesesData=MESES.map((_,m)=>{
    const cs=todos.filter(c=>c.ano===anoSel&&c.mes===m);
    return{m,fat:cs.filter(c=>c.status==='Faturado').reduce((s,c)=>s+c.total,0),agd:cs.filter(c=>c.status==='Aguardando').reduce((s,c)=>s+c.total,0),qtd:cs.length};
  });
  const maxVal=Math.max(...mesesData.map(d=>d.fat+d.agd),1);
  return(
    <div style={{background:C.card,borderRadius:8,padding:'16px',boxShadow:'0 1px 3px rgba(0,0,0,.08)',marginBottom:14}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
        <div style={{fontWeight:700,fontSize:12,color:C.text,textTransform:'uppercase'}}>Evolução mensal de receita</div>
        <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
          {anos.map(a=><button key={a} onClick={()=>setAnoSel(a)} style={{padding:'3px 10px',borderRadius:4,border:'none',background:anoSel===a?C.blue:'#ecf0f1',color:anoSel===a?'#fff':C.textMuted,cursor:'pointer',fontSize:11,fontWeight:700}}>{a}</button>)}
        </div>
      </div>
      <div style={{display:'flex',alignItems:'flex-end',gap:3,height:130}}>
        {mesesData.map((d,i)=>(
          <div key={i} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center'}}>
            <div style={{width:'100%',display:'flex',flexDirection:'column',justifyContent:'flex-end',height:100}}>
              {d.agd>0&&<div title={'Aguardando: '+moeda(d.agd)} style={{width:'100%',background:C.orange,opacity:.7,minHeight:d.agd>0?2:0,height:Math.max((d.agd/maxVal)*100,d.agd>0?2:0)+'px'}}/>}
              <div title={'Faturado: '+moeda(d.fat)} style={{width:'100%',background:C.green,borderRadius:'3px 3px 0 0',minHeight:d.fat>0?3:0,height:Math.max((d.fat/maxVal)*100,d.fat>0?3:0)+'px'}}/>
            </div>
            <div style={{fontSize:8,color:C.textMuted,marginTop:3,textAlign:'center'}}>{MESES[i].slice(0,3)}</div>
            {d.qtd>0&&<div style={{fontSize:8,color:C.blue,fontWeight:700}}>{d.qtd}</div>}
          </div>
        ))}
      </div>
      <div style={{display:'flex',gap:14,marginTop:8,justifyContent:'flex-end'}}>
        <span style={{fontSize:10,color:C.textMuted,display:'flex',alignItems:'center',gap:4}}><span style={{width:10,height:10,background:C.green,borderRadius:2,display:'inline-block'}}/>Faturado</span>
        <span style={{fontSize:10,color:C.textMuted,display:'flex',alignItems:'center',gap:4}}><span style={{width:10,height:10,background:C.orange,borderRadius:2,display:'inline-block'}}/>Aguardando</span>
      </div>
    </div>
  );
}

// --- PAINEL DE ALERTAS -------------------------------------------------------
function PainelAlertas({todos,implantacoes,onVerImplantacao}){
  const hoje=new Date();hoje.setHours(0,0,0,0);
  const atrasados=todos.filter(c=>{
    const impl=implantacoes[c.id]||{};
    if(impl.etapa==='processo_finalizado'||!impl.prazo)return false;
    return new Date(impl.prazo+'T12:00:00')<hoje;
  });
  const semPrazo=todos.filter(c=>{
    const impl=implantacoes[c.id]||{};
    return impl.etapa!=='processo_finalizado'&&!impl.prazo;
  });
  const agdFat=todos.filter(c=>c.status==='Aguardando');
  const totAgd=agdFat.reduce((s,c)=>s+c.total,0);
  if(!atrasados.length&&!semPrazo.length&&!agdFat.length)return null;
  return(
    <div style={{marginBottom:14}}>
      {atrasados.length>0&&(
        <div style={{background:'#fef2f2',border:'1px solid #fecaca',borderRadius:8,padding:'10px 14px',marginBottom:8,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <i className="ti ti-alert-triangle" style={{color:C.red,fontSize:16}}/>
            <span style={{fontSize:13,fontWeight:700,color:C.red}}>{atrasados.length} implantação(ões) atrasada(s)</span>
          </div>
          <button onClick={onVerImplantacao} style={{background:C.red,color:'#fff',border:'none',borderRadius:5,padding:'4px 12px',cursor:'pointer',fontSize:11,fontWeight:700}}>Ver →</button>
        </div>
      )}
      {semPrazo.length>0&&(
        <div style={{background:'#fffbeb',border:'1px solid #fde68a',borderRadius:8,padding:'10px 14px',marginBottom:8,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <i className="ti ti-clock-exclamation" style={{color:C.orange,fontSize:16}}/>
            <span style={{fontSize:13,fontWeight:700,color:C.orange}}>{semPrazo.length} cliente(s) sem prazo de implantação</span>
          </div>
          <button onClick={onVerImplantacao} style={{background:C.orange,color:'#fff',border:'none',borderRadius:5,padding:'4px 12px',cursor:'pointer',fontSize:11,fontWeight:700}}>Ver →</button>
        </div>
      )}
      {agdFat.length>0&&(
        <div style={{background:'#eff6ff',border:'1px solid #bfdbfe',borderRadius:8,padding:'10px 14px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <i className="ti ti-currency-dollar" style={{color:C.blue,fontSize:16}}/>
            <span style={{fontSize:13,fontWeight:700,color:C.blue}}>{agdFat.length} cliente(s) aguardando faturamento — {moeda(totAgd)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// --- META MENSAL -------------------------------------------------------------
function CardMeta({titulo,realizado,meta,onSetMeta,cor}){
  const pct=meta>0?Math.min(Math.round((realizado/meta)*100),100):0;
  const [editando,setEditando]=useState(false);
  const [val,setVal]=useState(String(meta||''));
  return(
    <div style={{background:C.card,borderRadius:8,padding:'14px 16px',boxShadow:'0 1px 3px rgba(0,0,0,.08)',flex:1,minWidth:200,borderTop:`3px solid ${cor}`}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
        <div style={{fontWeight:700,fontSize:12,color:C.text,textTransform:'uppercase'}}>{titulo}</div>
        {!editando
          ?<button onClick={()=>setEditando(true)} style={{background:'none',border:'none',color:C.blue,cursor:'pointer',fontSize:11,fontWeight:600}}>✏️</button>
          :<div style={{display:'flex',gap:4,alignItems:'center'}}>
            <input value={val} onChange={e=>setVal(e.target.value)} placeholder="Ex: 50000" style={{padding:'3px 6px',borderRadius:5,border:'1px solid #dde1e7',fontSize:12,width:90}}/>
            <button onClick={()=>{onSetMeta(parseFloat(String(val).replace(',','.'))||0);setEditando(false);}} style={{background:C.green,color:'#fff',border:'none',borderRadius:5,padding:'3px 8px',cursor:'pointer',fontSize:11,fontWeight:700}}>OK</button>
            <button onClick={()=>setEditando(false)} style={{background:'none',border:'none',color:C.textMuted,cursor:'pointer',fontSize:11}}>✕</button>
          </div>
        }
      </div>
      <div style={{display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:6}}>
        <span style={{color:C.textMuted}}>Realizado: <strong style={{color:cor}}>{moeda(realizado)}</strong></span>
        {meta>0&&<span style={{color:C.textMuted}}>{moeda(meta)}</span>}
      </div>
      {meta>0&&<>
        <div style={{height:8,borderRadius:4,background:'#ecf0f1',overflow:'hidden'}}>
          <div style={{height:'100%',borderRadius:4,background:pct>=100?C.green:pct>=70?cor:C.orange,width:pct+'%',transition:'width .4s'}}/>
        </div>
        <div style={{display:'flex',justifyContent:'space-between',marginTop:4,fontSize:10,color:C.textMuted}}>
          <span>{pct}% atingido</span>
          {pct<100?<span style={{color:C.orange}}>Faltam {moeda(meta-realizado)}</span>:<span style={{color:C.green}}>✓ Meta atingida!</span>}
        </div>
      </>}
      {!meta&&<div style={{fontSize:10,color:C.textMuted,marginTop:4}}>Clique em ✏️ para definir a meta.</div>}
    </div>
  );
}
function DuplasMetas({todos,metaSistema,metaEquip,onSetMetaSistema,onSetMetaEquip}){
  const hoje=new Date();
  const mesAtual=hoje.getMonth(),anoAtual=hoje.getFullYear();
  const csMes=todos.filter(c=>c.mes===mesAtual&&c.ano===anoAtual&&c.status==='Faturado');
  const realSist=csMes.reduce((s,c)=>s+(c.vS||0),0);
  const realEquip=csMes.reduce((s,c)=>s+(c.vE||0),0);
  return(
    <div style={{marginBottom:14}}>
      <div style={{fontSize:11,color:C.textMuted,fontWeight:700,textTransform:'uppercase',marginBottom:8}}>Metas — {MESES[mesAtual]}/{anoAtual}</div>
      <div style={{display:'flex',gap:12,flexWrap:'wrap'}}>
        <CardMeta titulo="Meta Sistema" realizado={realSist} meta={metaSistema} onSetMeta={onSetMetaSistema} cor={C.purple}/>
        <CardMeta titulo="Meta Equipamentos" realizado={realEquip} meta={metaEquip} onSetMeta={onSetMetaEquip} cor={C.teal}/>
      </div>
    </div>
  );
}

// --- PÁGINA DE RELATÓRIOS -----------------------------------------------------
function RelatoriosView({todos,implantacoes}){
  const [anoRel,setAnoRel]=useState('Todos');
  const [mesRel,setMesRel]=useState('Todos');
  const [vendRel,setVendRel]=useState('Todos');
  const [planoRel,setPlanoRel]=useState('Todos');
  const [statusRel,setStatusRel]=useState('Todos');
  const anosDisp=[...new Set(todos.map(c=>c.ano).filter(Boolean))].sort();
  const vendedores=['Todos',...new Set(todos.map(c=>c.vendedor).filter(v=>v&&v!=='—'))].sort();
  const fi={padding:'6px 10px',borderRadius:5,border:'1px solid #dde1e7',fontSize:12,color:'#2c3e50',background:'#fff'};
  const dadosFiltrados=todos.filter(c=>{
    if(anoRel!=='Todos'&&c.ano!==+anoRel)return false;
    if(mesRel!=='Todos'&&c.mes!==+mesRel)return false;
    if(vendRel!=='Todos'&&c.vendedor!==vendRel)return false;
    if(planoRel!=='Todos'&&c.plano!==planoRel)return false;
    if(statusRel!=='Todos'&&c.status!==statusRel)return false;
    return true;
  });
  const totFatR=dadosFiltrados.filter(c=>c.status==='Faturado').reduce((s,c)=>s+c.total,0);
  const totAgdR=dadosFiltrados.filter(c=>c.status==='Aguardando').reduce((s,c)=>s+c.total,0);
  const totSistR=dadosFiltrados.reduce((s,c)=>s+(c.vS||0),0);
  const totImplR=dadosFiltrados.reduce((s,c)=>s+(c.vI||0),0);
  const totEquipR=dadosFiltrados.reduce((s,c)=>s+(c.vE||0),0);
  const porEtapa=ETAPAS.map(e=>{
    const cs=todos.filter(c=>{const impl=implantacoes[c.id]||{};return impl.etapa===e.id;});
    return{...e,qtd:cs.length,clientes:cs};
  }).filter(e=>e.qtd>0);
  function nomeArq(){
    const p=['relatorio'];
    if(anoRel!=='Todos')p.push(anoRel);
    if(mesRel!=='Todos')p.push(MESES[+mesRel]);
    if(vendRel!=='Todos')p.push(vendRel.replace(/\s/g,'_'));
    if(planoRel!=='Todos')p.push(planoRel);
    if(statusRel!=='Todos')p.push(statusRel);
    return p.join('_');
  }
  return(
    <div>
      <div style={{background:C.card,borderRadius:8,padding:'16px',boxShadow:'0 1px 3px rgba(0,0,0,.08)',marginBottom:14}}>
        <div style={{fontWeight:700,fontSize:12,color:C.text,marginBottom:12,textTransform:'uppercase'}}>Filtros do relatório</div>
        <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
          <select value={anoRel} onChange={e=>setAnoRel(e.target.value)} style={fi}><option value="Todos">Todos os anos</option>{anosDisp.map(a=><option key={a}>{a}</option>)}</select>
          <select value={mesRel} onChange={e=>setMesRel(e.target.value)} style={fi}><option value="Todos">Todos os meses</option>{MESES.map((m,i)=><option key={i} value={i}>{m}</option>)}</select>
          <select value={vendRel} onChange={e=>setVendRel(e.target.value)} style={fi}>{vendedores.map(v=><option key={v}>{v}</option>)}</select>
          <select value={planoRel} onChange={e=>setPlanoRel(e.target.value)} style={fi}><option value="Todos">Todos os planos</option>{PLANOS.map(p=><option key={p}>{p}</option>)}</select>
          <select value={statusRel} onChange={e=>setStatusRel(e.target.value)} style={fi}><option value="Todos">Todos os status</option><option value="Faturado">✅ Faturado</option><option value="Aguardando">⏳ Aguardando</option></select>
          <span style={{fontSize:11,color:C.textMuted}}>{dadosFiltrados.length} cliente(s)</span>
        </div>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(130px,1fr))',gap:10,marginBottom:14}}>
        <StatCard icon="ti-users" label="Clientes" value={dadosFiltrados.length} color={C.blue}/>
        <StatCard icon="ti-check" label="Faturado" value={moeda(totFatR)} sub={dadosFiltrados.filter(c=>c.status==='Faturado').length+' clientes'} color={C.green}/>
        <StatCard icon="ti-clock" label="A faturar" value={moeda(totAgdR)} sub={dadosFiltrados.filter(c=>c.status==='Aguardando').length+' clientes'} color={C.orange}/>
        <StatCard icon="ti-code" label="Sistema/mês" value={moeda(totSistR)} color={C.purple}/>
        <StatCard icon="ti-device-laptop" label="Equipamentos" value={moeda(totEquipR)} color={C.teal}/>
        <StatCard icon="ti-tools" label="Implantações" value={moeda(totImplR)} color={C.orange}/>
      </div>
      <div style={{display:'flex',gap:10,marginBottom:14,flexWrap:'wrap'}}>
        <button onClick={()=>exportarExcel(dadosFiltrados,nomeArq()+'_clientes')} style={{display:'flex',alignItems:'center',gap:6,padding:'9px 18px',borderRadius:6,border:'none',background:C.green,color:'#fff',fontWeight:700,cursor:'pointer',fontSize:12}}>
          <i className="ti ti-file-spreadsheet"/> Exportar clientes (.csv)
        </button>
        <button onClick={()=>{const rows=porEtapa.flatMap(e=>e.clientes.map(c=>({...c})));exportarExcel(rows,nomeArq()+'_implantacao');}} style={{display:'flex',alignItems:'center',gap:6,padding:'9px 18px',borderRadius:6,border:'none',background:C.purple,color:'#fff',fontWeight:700,cursor:'pointer',fontSize:12}}>
          <i className="ti ti-file-spreadsheet"/> Exportar implantação (.csv)
        </button>
      </div>
      <div style={{background:C.card,borderRadius:8,padding:'16px',boxShadow:'0 1px 3px rgba(0,0,0,.08)',marginBottom:14}}>
        <div style={{fontWeight:700,fontSize:12,color:C.text,marginBottom:12,textTransform:'uppercase'}}>Implantações por etapa</div>
        {porEtapa.length===0&&<div style={{color:C.textMuted,fontSize:12,textAlign:'center',padding:'16px 0'}}>Nenhuma implantação registrada.</div>}
        {porEtapa.map(e=>(
          <div key={e.id} style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
            <div style={{width:10,height:10,borderRadius:2,background:e.color,flexShrink:0}}/>
            <div style={{flex:1,fontSize:12,color:C.text,fontWeight:600}}>{e.label}</div>
            <div style={{height:8,borderRadius:4,background:'#ecf0f1',width:140,flexShrink:0}}>
              <div style={{height:'100%',borderRadius:4,background:e.color,width:Math.min(Math.round((e.qtd/Math.max(todos.length,1))*400),100)+'%'}}/>
            </div>
            <div style={{fontSize:12,fontWeight:700,color:C.text,width:28,textAlign:'right'}}>{e.qtd}</div>
          </div>
        ))}
      </div>
      <div style={{background:C.card,borderRadius:8,boxShadow:'0 1px 3px rgba(0,0,0,.08)',overflow:'hidden'}}>
        <div style={{padding:'12px 16px',borderBottom:'1px solid '+C.border}}>
          <span style={{fontWeight:700,fontSize:13,color:C.text}}>Detalhamento — {dadosFiltrados.length} registros</span>
        </div>
        <div style={{overflowX:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',minWidth:700}}>
            <thead><tr style={{background:'#f8f9fa'}}>
              {['Empresa','CNPJ','Plano','Vendedor','Status','Sistema','Implantação','Equip.','Total'].map(h=>(
                <th key={h} style={{padding:'8px 10px',textAlign:'left',fontSize:10,color:C.textMuted,fontWeight:700,textTransform:'uppercase',whiteSpace:'nowrap'}}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {sortRecente(dadosFiltrados).slice(0,300).map((c,i)=>(
                <tr key={c.id} style={{borderTop:'1px solid '+C.border,background:i%2===0?'#fff':'#fdfdfd'}}>
                  <td style={{padding:'7px 10px',fontSize:11,fontWeight:600,color:C.text,maxWidth:160,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{c.nome}</td>
                  <td style={{padding:'7px 10px',fontSize:10,color:C.textMuted,whiteSpace:'nowrap'}}>{c.cnpj}</td>
                  <td style={{padding:'7px 10px'}}><span style={{background:'#ebf5fb',color:C.blue,padding:'1px 6px',borderRadius:8,fontSize:10,fontWeight:700}}>{c.plano}</span></td>
                  <td style={{padding:'7px 10px',fontSize:11,color:C.textMuted}}>{c.vendedor}</td>
                  <td style={{padding:'7px 10px'}}><span style={{background:corStatus(c.status)+'22',color:corStatus(c.status),padding:'1px 7px',borderRadius:8,fontSize:10,fontWeight:700}}>{labelStatus(c.status)}</span></td>
                  <td style={{padding:'7px 10px',fontSize:11,fontWeight:700,color:C.purple}}>{moeda(c.vS)}</td>
                  <td style={{padding:'7px 10px',fontSize:11,fontWeight:700,color:C.orange}}>{moeda(c.vI)}</td>
                  <td style={{padding:'7px 10px',fontSize:11,fontWeight:700,color:C.teal}}>{moeda(c.vE)}</td>
                  <td style={{padding:'7px 10px',fontSize:12,fontWeight:700,color:C.blue}}>{moeda(c.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {dadosFiltrados.length>300&&<div style={{padding:'10px',textAlign:'center',fontSize:11,color:C.textMuted}}>Mostrando 300 de {dadosFiltrados.length}. Exporte para ver todos.</div>}
        </div>
      </div>
    </div>
  );
}

// --- CSV BASE (dados históricos da planilha) ----------------------------------
const CSV_BASE=`12/30/2024;JR Apoio Logísticos;26.406.164/0001-07;Elaine;11 99618-0667;80;Evo40;0;1450;339;Cartão/Boleto;15/01/2025;financeiro@jrapoio.com.br;FATURADO/FINALIZADO;Pro;
12/30/2024;MAYCON LUAN DE CAMARGO;38.406.730/0001-60;Taison;42 9157-5284;3;Nenhum;0;0;69.9;Boleto;15/01/2025;mayconcamargo66@gmail.com;FATURADO/FINALIZADO;Basic;
1/9/2025;ELETROSOLENG ENERGIA E SERVICO LTDA;21.027.684/0001-95;FELIPE;99 8537-6355;10;Tablet;0;0;99.9;Boleto;15/01/2025;;FATURADO/FINALIZADO;Pro;
1/9/2025;DONINI & SALDANHA TELECOMUNICACOES LTDA;1;DONINI;15 99617-1396;30;Evo40;0;1450;149;Boleto;05/02/2025;financeiro@rapidatelecom.com.br;FATURADO/FINALIZADO;Basic;
1/9/2025;RAPIDA SUDOESTE TELECOMUNICACOES LTDA;35.000.733/0001-00;DONINI;15 99617-1396;10;Evo40;250;1450;99.9;Boleto;05/02/2025;financeiro@rapidatelecom.com.br;FATURADO/FINALIZADO;Basic;
1/9/2025;RAPIDA TELECOMUNICACOES LTDA;33.238.440/0001-30;DONINI;15 99617-1396;10;Evo40;250;1450;99.9;Boleto;05/02/2025;financeiro@rapidatelecom.com.br;FATURADO/FINALIZADO;Basic;
1/9/2025;RONALDO DA SILVA FERREIRA;58.543.759/0001-09;Ronaldo;11 97201-2521;5;Nenhum;0;0;69.9;Boleto;20/01/2025;mr.telecom846@gmail.com;FATURADO/FINALIZADO;Basic;
1/10/2025;ABF COMERCIO DE METAIS LTDA;30.829.729/0001-36;Adelchi;54 9942-2676;15;Evo40;250;1377.5;109.9;Boleto;05/02/2025;Adelchi@abfcomponentes.com.br;FATURADO/FINALIZADO;Pro;
1/14/2025;TELAS CUPECE ARAMES E FERRAGENS LTDA;45.952.553/0001-82;OGDA;11 99451-5860;15;Nenhum;0;0;129.9;Boleto;05/02/2025;contabil@telascupece.com.br;FATURADO/FINALIZADO;Pro;
1/21/2025;FGMA CURSOS AGUAS LINDAS;34.309.069/0001-13;Wesley;61 9304-7014;24;Evo40;0;0;142.56;Boleto;05/02/2025;dpescolas@gmail.com;FATURADO/FINALIZADO;Pro;
1/21/2025;LUZIANA CURSOS LTDA;20.047.021/0001-70;Wesley;61 9304-7014;25;Evo40;0;0;148.5;Boleto;05/02/2025;dpescolas@gmail.com;FATURADO/FINALIZADO;Pro;
1/21/2025;NASCIMENTO NASCIMENTO E LUCENA LTDA;47.145.686/0001-72;Wesley;61 9304-7014;18;Evo40;0;0;106.92;Boleto;05/02/2025;dpescolas@gmail.com;FATURADO/FINALIZADO;Pro;
1/21/2025;IFP CURSOS CAMPINA GRANDE LTDA;45.769.120/0001-96;Wesley;61 9304-7014;21;Evo40;0;0;124.74;Boleto;05/02/2025;dpescolas@gmail.com;FATURADO/FINALIZADO;Pro;
1/21/2025;IFP BRASILIA;49.306.672/0001-19;Wesley;61 9304-7014;24;Evo40;0;0;142.56;Boleto;05/02/2025;dpescolas@gmail.com;FATURADO/FINALIZADO;Pro;
1/21/2025;PARANOA IFP CURSOS LTDA;43.196.197/0001-99;Wesley;61 9304-7014;24;Evo40;0;0;142.8;Boleto;05/02/2025;dpescolas@gmail.com;FATURADO/FINALIZADO;Pro;
1/21/2025;IFP JOAO PESSOA;50.708.511/0001-30;Wesley;61 9304-7014;26;Evo40;0;0;130.9;Boleto;05/02/2025;dpescolas@gmail.com;FATURADO/FINALIZADO;Pro;
1/21/2025;IPR1 CURSOS E TREINAMENTOS LTDA;46.591.075/0001-95;Wesley;61 9304-7014;18;Evo40;0;0;107.1;Boleto;05/02/2025;dpescolas@gmail.com;FATURADO/FINALIZADO;Pro;
1/21/2025;MTW TREINAMENTO EM INFORMATICA LTDA;42.518.107/0001-76;Wesley;61 9304-7014;20;Evo40;0;0;101.15;Boleto;05/02/2025;dpescolas@gmail.com;FATURADO/FINALIZADO;Pro;
1/21/2025;TWM TREINAMENTO EM INFORMATICA LTDA;36.223.438/0001-86;Wesley;61 9304-7014;20;Evo40;0;0;119;Boleto;05/02/2025;dpescolas@gmail.com;FATURADO/FINALIZADO;Pro;
1/23/2025;JARDEL JAIME DE MOURA PIZZARIA;39.958.987/0001-97;JARDEL;12 99767-1571;5;Evo40;0;1450;69.9;Pix;05/02/2025;jardeljaime1@outlook.com;FATURADO/FINALIZADO;Basic;
1/23/2025;VIRGULA LOCACOES EVENTOS E DESIGN LTDA;59.005.225/0001-83;Diego;85 9979-8130;10;Nenhum;0;0;99.9;Boleto;05/02/2025;financeiro@virgulalocacoes.com.br;FATURADO/FINALIZADO;Pro;
1/24/2025;A. L. LIMA VERAS;27.330.001/0001-50;BRUNA;98 9965-0440;20;Nenhum;0;0;119.9;Boleto;05/02/2025;veras.2000@outlook.com;FATURADO/FINALIZADO;Pro;
1/24/2025;RINALDI MADEIRAS LTDA;23.670.099/0001-34;ALCIONE;15 99755-5178;10;Evo40;0;1487;99.9;A vista;10/02/2025;RINALDIMADEIRAS@HOTMAIL.COM;FATURADO/FINALIZADO;Pro;
1/27/2025;NICOLAS KELVIN BUENO SILVA;37.454.198/0001-93;Nelsiane;15 99779-1561;30;Evo40;350;1450;219;Boleto;20/02/2025;financeiro@oficinadovidroesquadrias.com.br;FATURADO/FINALIZADO;Pro;
1/28/2025;CR ENGENHARIA;44.916.436/0001-09;Bruna;98 8431-3030;10;Control ID;0;1790;99.9;Boleto;04/03/2025;crengenhariaatendimento@gmail.com;FATURADO/FINALIZADO;Pro;
1/30/2025;PINHEIRAO AUTO POSTO LTDA;75.061.747/0001-59;DANIEL;41 93500-1081;80;Nenhum;0;0;424.8;Boleto;;PELIKANO.DP@GMAIL.COM;FATURADO/FINALIZADO;Pro;
1/30/2025;NOBRECON EMPREENDIMENTOS LTDA;31.550.754/0001-49;CAMILA;47 3368-1664;15;Nenhum;0;0;119;Boleto;10/02/2025;Camila@nobreconempreendimentos.com.br;FATURADO/FINALIZADO;Pro;
2/3/2025;CALHAS INDUSTRIAL LTDA;32.389.100/0001-48;LUAM;31 8617-8832;10;Nenhum;0;0;99.9;Boleto;10/02/2025;calhasindustrial07@hotmail.com;FATURADO/FINALIZADO;Pro;
2/3/2025;WALTER WILLIAM SLEUTJES;33.899.580/0001-50;FREDERICO;14 99603-3513;20;Evo40;350;1450;159;Pix;10/02/2025;wwsfinanceiro@gmail.com;FATURADO/FINALIZADO;Pro;
2/3/2025;EDVANDRO MELO SANTOS;50.822.031/0001-04;VANIA;15 99859-9913;10;Evo40;0;1450;99.9;Boleto;10/02/2025;emesa.adm@gmail.com;FATURADO/FINALIZADO;Pro;
2/10/2025;E M BASTOS DA SILVA ENGENHARIA LTDA;35.763.173/0001-46;MICHELY;92 9230-9263;10;Nenhum;150;0;99.9;Pix;05/03/2025;Michely@ms-engenharia.com;FATURADO/FINALIZADO;Pro;
2/12/2025;JEL MATERIAIS ELETRICOS;39.910.495/0001-21;Lucas;49 9914-4621;15;Nenhum;0;0;129.9;Boleto;05/03/2025;jel.solucoeseletrica@hotmail.com;FATURADO/FINALIZADO;Pro;
2/12/2025;CLINICA DENTARIA SANTA BARBARA S/C LTDA;03.122.814/0001-97;JOÃO LUIZ;19 98161-1780;12;Evo40;0;1500;99.9;Pix;15/03/2025;joaolpeloso@gmail.com;FATURADO/FINALIZADO;Pro;
2/12/2025;CALHAS LIMA LTDA;49.840.488/0001-54;DANIELE;43 9908-4398;5;Nenhum;0;0;69.9;Boleto;20/02/2025;calhaslimaltda@gmail.com;FATURADO/FINALIZADO;Basic;
2/24/2025;ALEGU COMERCIO DE ALIMENTOS LTDA;09.531.892/0001-21;GUSTAVO;15 99702-1568;50;Evo40;350;2700;249;Boleto;08/04/2025;sousasuper2@hotmail.com;FATURADO/FINALIZADO;Pro;
2/25/2025;COLEGIO ANGLO BRASILEIRO LTDA;42.015.412/0001-45;Wellington;71 9336-9988;70;Evo40;0;2560;299;Boleto;;suporte@anglobra.com.br;FATURADO/FINALIZADO;Pro;
2/27/2025;GMG IMPORTACAO E EXPORTACAO LTDA;04.143.473/0001-07;EDUARDO;11 99976-0895;5;Evo40;100;1377;69.9;A vista;10/04/2025;Egrandal@terra.com.br;FATURADO/FINALIZADO;Basic;
3/5/2025;SUL IMPLANTES MATERIAIS ODONTOLOGICOS LTDA;10.973.630/0001-04;Iara;54 9124-2538;10;Nenhum;0;0;99.9;Boleto;15/03/2025;Rambo.iara@gmail.com;FATURADO/FINALIZADO;Pro;
3/5/2025;FGM CONSULTORIA EM CURSOS LTDA;37.036.469/0001-90;Wesley;61 9304-7014;20;Evo40;0;999;118.8;Boleto;;DPESCOLAS@GMAIL.COM;FATURADO/FINALIZADO;Pro;
3/5/2025;PORTO BRASIL SERVICO DE CORTE E DOBRA;56.033.586/0001-45;Robson;65 9801-6215;10;Evo40;0;1305;99.9;Boleto;05/04/2025;porto.brasillrv@gmail.com;FATURADO/FINALIZADO;Pro;
3/11/2025;N DOS SANTOS DIAS SERVICOS E COMERCIO LTDA;55.108.613/0001-39;Lauand;91 9373-8140;100;Evo40;0;1450;369;Boleto;10/04/2025;adm.malta01@gmail.com;FATURADO/FINALIZADO;Pro;
3/12/2025;L. BITENCOURT FRUTARIA LTDA;40.449.343/0001-52;Ketlyn;41 9719-1533;10;Evo40;0;1450;99.9;Boleto;;imperatrizmatriz@outlook.com;FATURADO/FINALIZADO;Pro;
3/19/2025;DOMUS PET LTDA;51.378.457/0001-75;Pollyana;99 8815-6101;3;Nenhum;0;0;59;Boleto;;domuspetboutique@gmail.com;FATURADO/FINALIZADO;Basic;
3/19/2025;AURORA BEAUTY LTDA;33.398.274/0001-30;VINICIUS;44 2020-7999;5;Nenhum;0;0;69.9;Boleto;;33.398.274/0001-30;FATURADO/FINALIZADO;Basic;
3/21/2025;JLS FABRICACAO DE PLASTICOS E EQUIPAMENTOS LTDA;28.022.249/0001-17;PATRICIA;71 9948-4058;40;Evo40;0;1450;249.9;Boleto;;Financeirofoxfiber@gmail.com;FATURADO/FINALIZADO;Pro;
3/24/2025;R ALMEIDA DE ARAÚJO LTDA;54.281.708/0001-97;Klevysom;99 8516-2210;40;Evo40;0;1232.5;249.9;Pix;;Comercialhadassa166@gmail.com;FATURADO/FINALIZADO;Pro;
3/24/2025;F&F SERVICOS OTICOS LTDA;53.931.270/0001-82;FABIANO;62 8252-7000;15;Nenhum;0;0;129.9;Boleto;03/04/2025;adm@oticasblue.com.br;FATURADO/FINALIZADO;Pro;
3/24/2025;J. D. PANIFICADORA E ALIMENTOS LTDA;20.014.365/0001-82;Rafael;31 9142-7789;5;Nenhum;0;0;69.9;Boleto;03/04/2025;rafael.oliveira.27@hotmail.com;FATURADO/FINALIZADO;Basic;
3/25/2025;JOANDERSON RIBEIRO DE JESUS;13.509.586/0001-66;TACIO;75 9950-2056;30;Evo40;0;1232;189;Pix;05/05/2025;Rexadmmoto@gmail.com;FATURADO/FINALIZADO;Pro;
4/2/2025;TIAGO LIEBL MIRANDA;11.152.599/0001-03;TIAGO;47 8409-1767;10;Evo40;0;1232.5;99.9;Cartão;;cireneu.moveis@gmail.com;FATURADO/FINALIZADO;Pro;
4/2/2025;ALIANCA LAVANDERIA;46.496.104/0001-30;JOSIANE;15 99690-6264;20;Nenhum;0;0;129.9;Boleto;;alianca.lavanderia@outlook.com;FATURADO/FINALIZADO;Pro;
4/2/2025;DIESEL CENTER PECAS E SERVICOS LTDA;03.061.459/0001-93;CAROL;84 9203-2135;50;Nenhum;0;0;349;Boleto;;benoaldo.miranda@gmail.com;FATURADO/FINALIZADO;Pro;
4/3/2025;FCC MADEIRAS;11.298.216/0001-00;Daniele;15 99811-7937;15;Evo40;0;1280;99.9;Boleto;10/04/2025;fcc@fccmadeiras.com.br;FATURADO/FINALIZADO;Pro;Nicolas
4/5/2025;ADRIANA DA CUNHA LIMA OLIVEIRA;21.262.633/0001-48;Luana;79 9876-6756;35;Evo40;0;2465;319;Pix;05/05/2025;EDINHOCOMIDACASEIRA@HOTMAIL.COM;FATURADO/FINALIZADO;Ultimate;Nicolas
4/7/2025;BRASIL TRUCK CENTER ITAPEVA LTDA;51.734.936/0001-87;Tiago;15 99627-5749;5;Evo40;0;1232.5;69.9;Boleto;07/05/2025;financeiro@brasiltruckcenter.com;FATURADO/FINALIZADO;Basic;Andreus
4/11/2025;CELIO VASCO DE ALMEIDA JUNIOR;44.958.546/0001-25;Célio;15 99196-1525;10;Evo40;250;1450;99.9;Boleto;10/05/2025;celiovasco87@gmail.com;FATURADO/FINALIZADO;Basic;Oséias
4/11/2025;CANOVAS INTERMEDIACAO DE VEICULOS LTDA;48.400.542/0001-88;DIEGO;35 9918-5527;20;Celular;0;0;159;Boleto;20/04/2025;CONTATO@VAAPTYPOUSOALEGRE.COM.BR;FATURADO/FINALIZADO;Ultimate;Andreus
4/15/2025;ZÉ DO FUMO;30.781.400/0001;ANA;15 99741-7057;10;Evo40;350;6162.5;109.9;Cartão;30/04/2025;anaclaudia.plima@icloud.com;FATURADO/FINALIZADO;Pro;Nicolas
4/23/2025;JARDIM DE SABORES CAFE LTDA;52.789.703/0001-44;Amanda;41 99546835;3;Celular;0;0;49.9;Boleto;25/04/2025;Financeirojardimdesabores@hotmail.com;FATURADO/FINALIZADO;Pro;Andreus
4/23/2025;SOS RIM ATENDIMENTO RENAL LTDA;09.373.779/0001-65;Daniel;41 93500-1081;50;Celular;0;0;289;Boleto;05/05/2025;CONTATO@RIM-ONLINE.COM.BR;Aguardando faturamento;Pro;Andreus
4/24/2025;CASA DA ESFIHA DE ITAPEVA LTDA;29.081.594/0001-94;Ronaldo;15 98809-1418;15;Evo40;350;1450;129;Boleto;24/06/2025;rs3768242@gmail.com;FATURADO/FINALIZADO;Basic;
4/25/2025;OTL - CONSORCIO ADUTOR CUITEGI;58.080.849/0001-00;Valéria;81 8814-9260;20;Tablet;0;0;159;Boleto;15/05/2025;recursoshumanos@otl.com.br;FATURADO/FINALIZADO;Ultimate;Matheus
4/28/2025;OTL - CNO BARRAGEM ITAIBA;00.545.355/0001-66;Valéria;81 8814-9260;10;Tablet;0;0;99.9;Boleto;15/04/2025;recursoshumanos@otl.com.br;FATURADO/FINALIZADO;Ultimate;Matheus
5/2/2025;JRW DE ANDRADE TRANSPORTES;01.503.394/0001-63;Andreza;15 99850-0434;10;Celular;0;0;99.9;Boleto;10/05/2025;jrwtransp@hotmail.com;FATURADO/FINALIZADO;Pro;Andreus
5/2/2025;MUNDO ANIMAL AGROPECUARIA LTDA;13.880.415/0001-49;MARCOS;99663-0660;30;Evo40;0;1450;219;Pix;02/06/2025;Mundoanimalitapeva01@gmail.com;FATURADO/FINALIZADO;Pro;Andreus
5/5/2025;CASA DO SABAO PROLAR;37.859.609/0001-20;CARLOS;83 9329-6674;20;Celular;0;0;169;Boleto;15/05/2025;PR.CARLOSMENESES@GMAIL.COM;FATURADO/FINALIZADO;Pro;Andreus
5/6/2025;WENDREL DOS REIS MONTEIRO DA SILVA LTDA;29.446.953/0001-60;Julianne;92 9290-7875;20;Evo40;1450;0;149;Boleto;05/06/2025;wmlogisticaintermodal@gmail.com;FATURADO/FINALIZADO;Pro;Andreus
5/9/2025;CESAR FERNANDES GIRARD;17.049.841/0001-96;Gabriel;15 99132-4884;10;Evo40;350;1450;60;Boleto;09/06/2025;fazendasantairene@outlook.com;FATURADO/FINALIZADO;Pro;Andreus
5/12/2025;TODOS ADMINISTRADORA DE CARTAO LTDA;38.351.307/0001-00;Emilly;15 99124-2599;20;Control ID;350;0;149;Boleto;30/05/2025;itapeva.sp@cartaodetodos.com;FATURADO/FINALIZADO;Pro;Nicolas
5/14/2025;EDIANDER BEHLKE ZUGE LTDA;31.956.673/0001-43;Anelise;51 9678-8386;20;Celular;0;0;149;Boleto;05/06/2025;prsmonitoramentocachoeira@gmail.com;FATURADO/FINALIZADO;Pro;Andreus
5/14/2025;SABRINA DUARTE MALTA GUIMARAES LTDA;42.596.389/0001-20;Elizete;91 9121-2049;15;Evo40;0;1450;109;Boleto;30/05/2025;adm.malta01@gmail.com;FATURADO/FINALIZADO;Pro;Nicolas
5/15/2025;SELLER MECANICA INDUSTRIA E COMERCIO LTDA;01.162.000/0001-50;CELSO;15 99670-7339;25;Evo40;150;1450;139.9;Boleto;05/06/2025;sellermecanica@gmail.com;FATURADO/FINALIZADO;Basic;Andreus
5/26/2025;IFP BRASIL LTDA;57.080.761/0001-18;Wesley;61 9304-7014;20;Já possui;0;0;99.9;Boleto;05/06/2025;DPESCOLAS@GMAIL.COM;FATURADO/FINALIZADO;Basic;Matheus
5/26/2025;A.G.BASSO COMERCIO DE CEREAIS;31.125.400/0001;BRUNA;14 99632-8255;50;Evo40;0;1180;311.25;Cartão;26/07/2025;Dp@agbbrasil.com;FATURADO/FINALIZADO;Pro;Andreus
5/30/2025;BRITO CHOPPERIA E LANCHES LTDA;36.056.963/0001-54;FELIPE;48 8432-3714;10;Evo40;0;2465;79.9;Boleto;05/06/2025;;FATURADO/FINALIZADO;Basic;Andreus
5/30/2025;FABIO H. TETSUYA;51.783.445/0001-26;FÁBIO;15 99627-7015;10;Evo40;350;1450;99;Boleto;05/06/2025;JOAO.PAULO_FADINI.RM@HOTMAIL.COM;FATURADO/FINALIZADO;Basic;Oséias
6/3/2025;RAPHAQUEL COMERCIO DE MARMORES LTDA;10.265.397/0001-05;FLavia;15 99836-7885;10;Evo40;150;1450;99.9;Boleto;03/07/2025;;FATURADO/FINALIZADO;Pro;Andreus
6/3/2025;ENI DE JESUS BARROS OLIVEIRA;36.990.581/0001-01;Ení;15 99623-3742;12;Evo40;350;1450;99.9;Cartão;05/07/2025;serrariavitoria2@hotmail.com;FATURADO/FINALIZADO;Basic;Andreus
6/4/2025;APENG SERVICOS E CONSTRUCOES LTDA;30.037.029/0001-09;Audrey;11 99613-3143;100;Celular;350;0;602;Boleto;15/06/2025;Audrey@apeng.eng.br;FATURADO/FINALIZADO;Ultimate;Andreus
6/6/2025;CONDOMINIO AMAZONIA EDIFICIO RIO CAICARA;42.398.156/0001-12;Nádia;71 9964-5972;10;Celular;0;0;99.9;Boleto;15/06/2025;rhmetrica@gmail.com;FATURADO/FINALIZADO;Ultimate;Andreus
6/6/2025;A VENDA RESTAURANTE LTDA;37.581.686/0001-61;NADIA;71 9964-5972;10;Celular;0;0;99.9;Boleto;15/06/2025;avendarestaurante@gmail.com;FATURADO/FINALIZADO;Ultimate;Andreus
6/6/2025;REVEIRA MONTAGENS INDUSTRIAL LTDA;46.447.971/0001-85;Karine;47 9934-5046;40;Evo40;0;1450;249;Boleto;15/06/2025;CONTATO@REVEIRA.COM.BR;FATURADO/FINALIZADO;Pro;Matheus
6/11/2025;HELLEN CARNEIRO DA SILVA;108.231.807-86;Hellen;21 97208-1960;5;Evo40;0;1450;69.9;Boleto;20/06/2025;Hellencarneiro.adv@gmail.com;FATURADO/FINALIZADO;Ultimate;Matheus
6/16/2025;DELSSIS PECAS E SERVICOS LTDA;35.428.147/0001-61;MARCIELLI;15 99653-6263;10;Celular;0;0;69.9;Boleto;05/07/2025;marcielleassis@hotmail.com;FATURADO/FINALIZADO;Ultimate;Andreus
6/21/2025;MUNDO ANIMAL AGROPECUARIA LTDA 2;13.880.415/0001-49;MARILDA;15 99663-0660;30;Evo40;1450;0;219;Pix;05/07/2025;Mundoanimalitapeva01@gmail.com;FATURADO/FINALIZADO;Pro;Andreus
6/23/2025;BEBE CRESCI LTDA;26.223.676/0001-38;EDUARDO;15 99665-3131;15;Evo40;2900;0;99.9;Boleto;01/07/2025;lojabebecresci@gmail.com;FATURADO/FINALIZADO;Pro;Andreus
6/23/2025;G E LENTES LTDA;27.075.778/0001-16;Ana;84 9458-3326;10;Celular;0;0;69.9;Boleto;15/07/2025;annaclaraalves0818@gmail.com;FATURADO/FINALIZADO;Ultimate;Andreus
6/24/2025;TROPICAL COMERCIO DE PRODUTOS OPTICOS LTDA;62.032.297/0001-24;SERGIO;11 99997-2020;10;Já possui;0;0;99.9;Pix;25/07/2025;opticatropical@uol.com.br;FATURADO/FINALIZADO;Basic;Andreus
6/26/2025;DIVULGA MIDIAS E SERVICOS LTDA;39.661.910/0001-50;André;15 99767-6241;15;Evo40;0;1450;119.9;Boleto;05/07/2025;financeiro.divulgacv@gmail.com;FATURADO/FINALIZADO;Pro;Andreus
6/26/2025;DIESEL CENTER PECAS E SERVICOS LTDA PB;59.208.844/0001-75;Gabrielly;84 9187-3525;10;Tablet;0;0;99.9;Boleto;01/07/2025;Dieselcenterpb23@gmail.com;FATURADO/FINALIZADO;Ultimate;Andreus
7/2/2025;ASSOCIACAO BENEFICENTE DE APIAI;43.723.900/0001;Ana;15 99749-1483;180;Evo40;0;1450;781.2;Boleto;20/07/2025;financeiro@abasaude.org;FATURADO/FINALIZADO;Pro;Andreus
7/4/2025;LOLA GELATO LTDA;60.778.788/0001-93;Paula;15 99115-1488;5;Tablet;0;0;69.9;Boleto;15/07/2025;PAULAFMELLO28@GMAIL.COM;FATURADO/FINALIZADO;Ultimate;Matheus
7/4/2025;OTL - RESERVA DO PAIVA;00.545.355/0001-66;Valéria;81 8814-9260;20;Tablet;0;0;159;Boleto;15/07/2025;recursoshumanos@otl.com.br;FATURADO/FINALIZADO;Ultimate;Matheus
7/7/2025;M.R.B-MATERIAL DE CONSTRUCAO LTDA;36.018.067/0001-09;Thiago;27 99943-0325;15;Evo40;0;1160;149;Boleto;15/07/2025;thiago@mrb.mat.br;FATURADO/FINALIZADO;Basic;Andreus
7/8/2025;ALFA TATICA MONITORAMENTO LTDA;51.499.779/0001-72;Marcela;92 8128-5656;10;Celular;0;0;69.9;Boleto;15/07/2025;Marcela.alfatatica@gmail.com;FATURADO/FINALIZADO;Ultimate;Andreus
7/15/2025;ALPHA GAS NATURAL LTDA;04.772.328/0001-87;LINO;12 99731-6299;5;Evo40;0;1300;69.9;Pix;15/08/2025;lchiapinotto@gmail.com;FATURADO/FINALIZADO;Basic;Andreus
7/15/2025;Brumed Consultório Médico Ltda;04.902.701/0001-77;Fernanda;15 99121-1608;60;Evo40;0;2360;349.9;Boleto;25/08/2025;rhcomprafin@b1-brumed.com.br;FATURADO/FINALIZADO;Pro;Andreus
7/28/2025;POLICLINICA APOIO ADMINISTRATIVO LTDA;35.342.672/0001-60;DANIEL;41 93500-1081;10;Celular;0;0;99.9;Boleto;02/08/2025;GUARAITUBAPOLICLINICA@GMAIL.COM;FATURADO/FINALIZADO;Pro;Andreus
7/28/2025;RIBEIRO E JACINTO LTDA;21.407.196/0001-03;DANIEL;41 93500-1081;25;Celular;0;0;189;Boleto;02/08/2025;rh@mabconsultoria.com.br;FATURADO/FINALIZADO;Pro;Andreus
8/1/2025;Benfica Empresa de Transportes Ltda;62.226.717/0001-03;Leonardo;11 99265-6957;5;Já possui;0;0;69.9;Boleto;10/08/2025;leonardo@benficatransportes.com.br;FATURADO/FINALIZADO;Basic;Andreus
8/4/2025;ALPHA VIDROS BM VIDROS LTDA;14.062.968/0001-57;BRUNO;71 8818-0908;10;Celular;0;0;99.9;Boleto;10/08/2025;bruno@alphavidros.com;FATURADO/FINALIZADO;Pro;Andreus
8/6/2025;MATOS & MATOS CONSTRUCAO CIVIL LTDA;08.613.588/0001-60;Jheile;41 8455-6839;20;Evo40;0;1450;149;Boleto;05/09/2025;r3bconstrucaocivil@gmail.com;FATURADO/FINALIZADO;Pro;Andreus
8/6/2025;JULIANA DE ABREU ARAUJO;16.501.953/0001-73;Helton;35 9993-2988;15;Evo40;1450;0;129;Boleto;06/09/2025;ECBRASIL@GMAIL.COM;FATURADO/FINALIZADO;Basic;Andreus
8/7/2025;HOPE TELECOM SOUZA LTDA;52.465.616/0001-31;DAIANE;37 9927-3518;10;Celular;0;0;99.9;Boleto;22/08/2025;daianesantos2527@gmail.com;FATURADO/FINALIZADO;Pro;Andreus
8/8/2025;GODOY DELIVERY;37.411.441/0001-96;Guilherme;15 99769-8585;20;Evo40;350;1450;149.9;Boleto;10/09/2025;godoydelivery.itapeva@gmail.com;FATURADO/FINALIZADO;Pro;Oséias
8/13/2025;LUIZ VIEIRA DE MORAIS EMBALAGENS;05.271.641/0001-02;Sidneide;88 9698-6184;50;Evo40;0;1450;299;Boleto;05/09/2025;suporteljatacadista@gmail.com;FATURADO/FINALIZADO;Pro;Andreus
8/19/2025;MG MONITORAMENTO E SERVICOS TERCEIRIZADOS LTDA;32.090.600/0001;André;99611-9202;30;Celular;0;0;219;Boleto;25/08/2025;pol.mg@hotmail.com;FATURADO/FINALIZADO;Pro;Andreus
8/26/2025;R DE O MONTEIRO LTDA;20.655.169/0001-97;PATRICIA;82 8833-7583;160;Celular;0;0;650.28;Boleto;05/08/2025;adm.alfaseguranca@gmail.com;FATURADO/FINALIZADO;Pro;Andreus
8/26/2025;CONTATTO PLAZA ACESSORIOS PESSOAIS LTDA;15.479.093/0001-56;Alberto;11 95026-9771;20;Evo40;0;3480;139;Boleto;10/09/2025;dirmoranaabc@gmail.com;FATURADO/FINALIZADO;Pro;Andreus
8/27/2025;CARDOSO LOCACOES E EMPREENDIMENTOS LTDA;40.543.205/0001-38;TATIANE;17 99623-4491;25;Celular;0;0;198.75;Boleto;01/10/2025;DANIELCARDOSO@CARDOSOTERRAPLENAGEM.COM.BR;FATURADO/FINALIZADO;Ultimate;Andreus
8/28/2025;ALVES & SILVA PAES LTDA;10.524.131/0001-21;Patrícia;62 9492-0215;50;Evo40;0;1232;289;Boleto;05/10/2025;Pmbtavares12@gmail.com;FATURADO/FINALIZADO;Pro;Andreus
9/2/2025;BENEDICTO PEREIRA FILHO LTDA;21.073.224/0001-01;Benedito;67 9940-2038;10;Evo40;0;1232;99.9;Cartão;05/10/2025;paocongelado.gabriela@gmail.com;FATURADO/FINALIZADO;Pro;Andreus
9/6/2025;Mercado fogaça;07.431.907/0001-54;Luciano;15 99685-9605;5;Evo40;350;1450;69.9;Cartão;15/10/2025;mariastellafogaca@icloud.com;FATURADO/FINALIZADO;Basic;Oséias
9/6/2025;KOMPRAO ATACADO E VAREJO ITAPEVA LTDA;54.456.532/0001-67;Shirley;15 99639-5739;30;Evo40;0;1490;204;Boleto;15/09/2025;komprao.rh@gmail.com;FATURADO/FINALIZADO;Ultimate;Andreus
9/9/2025;LOJAO SUPER 20 CUPIRA LTDA;57.224.408/0001-64;Marcos;83 9632-9133;10;Evo40;0;1450;99.9;Boleto;02/10/2025;Lojaosuper20cupira@gmail.com;FATURADO/FINALIZADO;Pro;Andreus
9/10/2025;C.E E BUFFET LTDA;28.185.412/0001-62;Gabriel;62 9844-0929;15;Celular;0;0;124.9;Boleto;30/09/2025;castruseventos@gmail.com;FATURADO/FINALIZADO;Pro;Nicolas
9/11/2025;RESTAURANTE CARMELA E SAL LTDA;58.342.622/0001-88;Sara;11 96385-1186;5;Evo40;0;1450;69.9;Boleto;02/10/2025;anaivsara@gmail.com;FATURADO/FINALIZADO;Pro;Andreus
9/11/2025;NATAN SILVA OLIVEIRA LANCHONETE LTDA;50.649.527/0001-10;Natan;14 99167-3343;5;Evo40;0;1450;69.9;Boleto;02/10/2025;natansilvaoliveira16@icloud.com;FATURADO/FINALIZADO;Basic;Andreus
9/12/2025;JAIR CORREA DE ASSIS FAZENDA COLOSSO;09.187.767/0002-27;Thays;15 99665-5329;20;Celular;0;0;169;Boleto;02/10/2025;thais.assis@mcolosso.com.br;FATURADO/FINALIZADO;Ultimate;Andreus
9/12/2025;LAURA ELISA ABREU LOUREIRO;48.823.569/0001-83;Laura;15 99647-2907;5;Evo40;0;1450;69.9;Boleto;02/10/2025;lauraelisaloureiro@outlook.com;FATURADO/FINALIZADO;Basic;Andreus
9/16/2025;SUPERMERCADO LOUREIRO DE ALMEIDA ITABERA LTDA;74.679.424/0001-60;Natalia;15 99723-9371;15;Evo40;350;1450;149;Boleto;02/10/2025;supermercadoloureiro1@bol.com.br;FATURADO/FINALIZADO;Pro;Andreus
9/18/2025;MAPSAFE ENGENHARIA LTDA;49.307.979/0001-34;Felipe;11 97421-5245;5;Celular;0;0;69.9;Boleto;02/10/2025;FELIPE@ENGMAPECONSULTORIA.COM.BR;FATURADO/FINALIZADO;Ultimate;Andreus
9/19/2025;OLIVEIRA E SANTOS TELECOM LTDA;19.429.124/0001-15;Junior;82 9913-2670;15;Já possui;0;0;119;Boleto;02/10/2025;JUNIORNETPROVEDOR@LIVE.COM;FATURADO/FINALIZADO;Pro;Andreus
9/25/2025;MANPLUS PRAGAS URBANAS LTDA;21.332.219/0001-68;Felipe;11 94071-7484;10;Já possui;0;0;139.8;Boleto;15/09/2025;manpluspragas@gmail.com;FATURADO/FINALIZADO;Ultimate;Nicolas
9/25/2025;TEODORO RIBEIRO DE SOUZA JUNIOR LTDA;02.938.290/0001-44;Junior;15 99701-2449;10;Evo40;0;1232.5;99.9;Boleto;02/09/2025;escritorioapiai@uol.com.br;FATURADO/FINALIZADO;Pro;Nicolas
9/30/2025;ANDRE LUIZ GARCIA FERRAMENTARIA LTDA;12.457.711/0001-79;Daiane;18 99690-9036;5;Já possui;150;0;69.9;Pix;05/10/2025;usitecmoldes@gmail.com;FATURADO/FINALIZADO;Basic;Andreus
10/3/2025;SAMURAI DISTRIBUIDORA DE AUTO PECAS LTDA;24.334.605/0001-87;RAPHAEL;11 93474-9657;10;Evo40;0;1080;99.9;Boleto;06/10/2025;Financeirosamuraidistribuidora@gmail.com;FATURADO/FINALIZADO;Basic;Andreus
10/3/2025;LUMINOUS SOL EDUCACAO LTDA;50.160.262/0001-91;Evelin;15 99785-5529;100;Evo40;0;2365;408;Boleto;17/10/2025;financeiro@colegioluminoussol.com.br;FATURADO/FINALIZADO;Pro;Andreus
10/6/2025;CAMPOLIM GELATO LTDA;61.262.225/0001-00;Claudio;15 99784-4080;15;Evo40;628.98;1450;119;Boleto;15/10/2025;borelli.tatui@gmail.com;FATURADO/FINALIZADO;Basic;Andreus
10/10/2025;JULIANE CRISTINE PRESTES ROSA;02.656.831/0001-41;Luis Fernando;15 99861-1212;20;Evo40;150;1450;149.9;A vista;15/11/2025;blits.escritorio@hotmail.com;FATURADO/FINALIZADO;Pro;Oséias
10/24/2025;PRETORIANO SEGURANCA PRIVADA LTDA;48.819.609/0001-13;Patrícia;82 8833-7583;220;Celular;0;0;792;Boleto;15/11/2025;pretorianoadm@gmail.com;FATURADO/FINALIZADO;Ultimate;Nicolas
10/28/2025;ARTFORCE INDUSTRIA E COMERCIO DE SEMI JOIAS LTDA;19.403.828/0001-19;JULIANA;19 98818-9231;20;Evo40;0;1450;139.9;Boleto;01/12/2025;departamentopessoal@artforce.com.br;FATURADO/FINALIZADO;Pro;Andreus
11/3/2025;DAZAN EQUIPAMENTOS AGRICOLAS LTDA;00.727.819/0001-55;Carlos;35 8808-5048;5;Celular;0;0;69.9;Boleto;10/11/2025;carlosmiranda478@gmail.com;FATURADO/FINALIZADO;Ultimate;Andreus
11/4/2025;HOTEL ELITHI S/S LTDA;28.068.150/0001-56;Thiago;47 9906-8782;10;Evo40;297.5;1232.5;99;Boleto;01/12/2025;contato@hotelelithi.com.br;FATURADO/FINALIZADO;Basic;Andreus
11/10/2025;JEDSON RODRIGUES DE OLIVEIRA LTDA;46.056.166/0001-20;Silvia;15 99626-5136;5;Celular;0;0;69.9;Boleto;15/11/2025;silviafelipesantana@gmail.com;FATURADO/FINALIZADO;Pro;Andreus
11/12/2025;MINATEL ODONTOLOGIA LTDA;40.454.716/0001-83;DIEGO;14 99718-7440;10;Evo40;200;1232.5;99.9;Dinheiro;02/12/2025;minatelodontologia@hotmail.com;FATURADO/FINALIZADO;Basic;Andreus
11/13/2025;VO LENITA SOLUCOES LTDA;50.092.993/0001-47;Michele;15 99835-0555;35;Evo40;0;3697.5;170;Boleto;30/11/2025;restaurantevolenita@hotmail.com;FATURADO/FINALIZADO;Pro;Nicolas
11/19/2025;FLEXIMEDICAL SOLUCOES EM SAUDE LTDA;07.384.026/0001-20;Rosangela;11 95591-6215;20;Evo40;0;1232.5;129;Boleto;10/01/2026;rh@fleximedical.com.br;FATURADO/FINALIZADO;Pro;Andreus
11/19/2025;NAIRAN FELIPE DOS SANTOS MOLINARI LTDA;43.644.596/0001-75;NAIRAN;41 9605-1528;5;Evo40;0;1100;69.9;Boleto;05/12/2025;RLCONTABILIDADE6@GMAIL.COM;FATURADO/FINALIZADO;Basic;Andreus
11/21/2025;FARMACIA GRUPO DESCONTAO LTDA;11.880.769/0001-68;Renan;13 99741-7156;40;Evo40;0;3697.5;195;Boleto;15/12/2025;renan@grupodesc.com.br;FATURADO/FINALIZADO;Pro;Nicolas
11/26/2025;L C MATOS ACOUGUE LTDA;61.735.914/0001-95;Luiz Claudio;15 99790-5590;10;Celular;0;0;99.9;Boleto;10/12/2025;luiz_claudio_mat@yahoo.com.br;FATURADO/FINALIZADO;Ultimate;Andreus
11/26/2025;PAULO CESAR PAVONI;08.499.775/0002-46;Isabely;15 99606-8055;30;Evo40;550;3696;148.5;Boleto;10/12/2025;alessandracarijo@hotmail.com;FATURADO/FINALIZADO;Basic;Andreus
11/26/2025;GSPACK COMERCIO E INDUSTRIA PLASTICAS LTDA;49.966.002/0001-29;Fabiana;11 97373-8102;20;Evo40;0;1150;119;Pix;25/12/2025;fabiana.saraiva@saraplast.com;FATURADO/FINALIZADO;Pro;Nicolas
11/27/2025;PRIME IMPORTACAO E EXPORTACAO LTDA;24.306.357/0003-22;Sidneide;88 9320-6085;75;Evo40;0;989;400;Pix;08/01/2026;rh@mundodeled.com.br;FATURADO/FINALIZADO;Ultimate;Nicolas
12/1/2025;MFL MINIMERCADO LTDA;23.800.334/0001-45;Marcia;11 96905-1437;10;Evo40;0;989;699;Boleto;01/12/2026;marciafa.lima@hotmail.com;FATURADO/FINALIZADO;Basic;Andreus
12/1/2025;NOVACURA INDUSTRIA E COMERCIO DE MAQUINAS UV LTDA;07.021.664/0001-86;PALOMA;21 99202-3126;10;Evo40;0;1232;89;Pix;10/01/2026;comex@novacura.com.br;FATURADO/FINALIZADO;Basic;Andreus
12/2/2025;S&A RETIFICA DE MOTORES LTDA;08.100.784/0001-31;Ana Paula;15 99747-5031;15;Evo40;0;1232;110;Boleto;15/12/2025;SEARETIFICA@HOTMAIL.COM;FATURADO/FINALIZADO;Basic;Matheus
12/5/2025;MULTITEC SOLUCOES EM OUTSOURCING LTDA;03.917.935/0001-25;Fernando;15 99755-8153;10;Evo40;0;1232;69.9;Pix;01/01/2026;financeiromultitec@terra.com.br;FATURADO/FINALIZADO;Ultimate;Gabriel
12/9/2025;GOSTINHO DE MINAS;34.168.082/0001-08;Rute;31 8859-0665;5;Celular;0;0;69.9;Boleto;10/01/2026;gostinhodeminas@yahoo.com;FATURADO/FINALIZADO;Ultimate;Nicolas
12/11/2025;SUPER SPORT BELEM LTDA;46.064.985/0001-10;Super Sport;91 8333-6799;10;Tablet;0;0;99.9;Boleto;05/01/2026;CAMISARIAPRIMART@GMAIL.COM;FATURADO/FINALIZADO;Ultimate;Nicolas
12/16/2025;PANIGHEL ODONTOLOGIA;133.551.798-76;Cesar;13 99667-1070;5;Evo40;0;1232.5;69.9;Cartão;10/01/2026;panighelodontologia@gmail.com;FATURADO/FINALIZADO;Pro;Matheus
12/17/2025;PARAFERNALHA SERVICOS DE LOCACOES LTDA;13.278.504/0001-10;Vivien;85 9985-8517;10;Celular;0;0;99.9;Boleto;15/01/2026;parafernalha.adm@gmail.com;FATURADO/FINALIZADO;Pro;Matheus
12/19/2025;ALICE FERNANDA DIAS ALMEIDA FOGACA;07.532.202/0001-23;EDUARDO;15 99655-1310;35;Evo40;100;1450;189;Boleto;10/01/2026;edukandoferas@gmail.com;FATURADO/FINALIZADO;Pro;Andreus
12/22/2025;CENTRAL MODAS LTDA;65.393.027/0001-37;Rosana;15 99625-4822;11;Evo40;0;1450;99.9;Boleto;01/02/2026;centralmodasadm@gmail.com;FATURADO/FINALIZADO;Basic;Andreus
1/9/2026;Auto Posto Quatizada;02.129.788/0001-66;GUILHERME;;15;Evo40;350;1377.5;119;Boleto;16/01/2026;posto@quatizada.com;FATURADO/FINALIZADO;Basic;Andreus
1/9/2026;Auto Posto Trevo de Itaberá;74.540.402/0001-15;GUILHERME;15 99661-6800;15;Evo40;0;1377.5;119;Boleto;16/01/2026;posto@quatizada.com;FATURADO/FINALIZADO;Basic;Andreus
1/10/2026;ELIANE DA CRUZ FERREIRA;31.414.763/0001-02;ELIANE;19 99642-4570;5;Celular;0;0;69.9;Boleto;15/02/2026;kasadanonna24@gmail.com;FATURADO/FINALIZADO;Pro;Andreus
1/13/2026;CIRCULAR LTDA;54.284.225/0001-46;Nathália;34 9707-2270;5;Celular;0;0;69.9;Boleto;20/02/2026;admin@luxocircular.com;FATURADO/FINALIZADO;Ultimate;Nicolas
1/14/2026;BAUMGARTEN PORTARIA E ZELADORIA LTDA;13.687.800/0001;TÂNIA;47 9112-4358;10;Celular;0;0;99.9;Boleto;20/01/2026;baumgartenportariaezeladoria@gmail.com;FATURADO/FINALIZADO;Basic;Andreus
1/15/2026;IANDEBO AGROFLORESTAL LTDA;08.323.436/0001-23;Juliana;15 99175-5735;50;Evo40;350;1450;219;Boleto;15/02/2026;juliana@iandebo.com.br;FATURADO/FINALIZADO;Basic;Andreus
1/21/2026;Supermercado novo horizonte;46.698.081/0001-46;Acelino;15 99750-9539;18;Evo40;350;1450;129;Boleto;12/01/2026;mpvinas_sp@hotmail.com.br;FATURADO/FINALIZADO;Pro;Oséias
1/21/2026;CELV - CRECHE ESCOLA LICAO DE VIDA LTDA;14.692.309/0002-85;ANSELMO;21 97018-1429;5;Celular;0;0;69.9;Boleto;05/02/2026;Crecheescolalicaodevida@gmail.com;FATURADO/FINALIZADO;Ultimate;Andreus
1/28/2026;NOVA TERRA SERVICOS DE ENGENHARIA LTDA;00.254.228/0001-08;Valéria;81 8814-9260;20;Já possui;0;0;136.6;Boleto;15/03/2026;recursoshumanos@otl.com.br;FATURADO/FINALIZADO;Ultimate;Nicolas
1/28/2026;CONSORCIO SAA CABO DE SANTO AGOSTINHO;46.066.564/0001-28;Valéria;81 8814-9260;30;Já possui;0;0;204.9;Boleto;15/03/2026;recursoshumanos@otl.com.br;FATURADO/FINALIZADO;Ultimate;Nicolas
1/30/2026;FOTOS E PHOTOS SHOP LTDA;20.506.100/0001;FERNANDO;11 99751-3846;20;Evo40;0;4360;129.9;Pix;05/03/2026;adm.fotosephotos@hotmail.com;FATURADO/FINALIZADO;Basic;Andreus
2/3/2026;SIDINEI A FEITOZA SOLUCOES EM IMAGEM;12.540.364/0001-43;THAYANE;21 97603-6291;10;Evo40;0;1450;79.9;Boleto;10/03/2026;financeiro@cvcreative.com.br;FATURADO/FINALIZADO;Ultimate;Nicolas
2/4/2026;GUSTAVO GEMINIANI DE OLIVEIRA;21.034.670/0001-07;Tais;15 99617-5998;10;Evo40;0;1450;99.9;Pix;15/03/2026;comercialgeoserv@gmail.com;FATURADO/FINALIZADO;Ultimate;Nicolas
2/6/2026;CLUBE DOS CINCOENTA;18.096.339/0001-07;LUCIANO;32 9813-4031;10;Evo40;0;1150;69.9;Boleto;05/03/2026;clube_50@ymail.com;FATURADO/FINALIZADO;Basic;Andreus
2/18/2026;RV COMPANY AUTO CENTER LTDA;39.146.190/0001-95;GUSTAVO;14 99851-0035;5;Evo40;0;1150;49.9;Boleto;20/03/2026;contato-rv@outlook.com;FATURADO/FINALIZADO;Basic;Andreus
2/18/2026;RONALDO CONRADO DE SOUZA;57.179.228/0001-08;RONALDO;13 97417-6230;5;Evo40;0;1150;49.9;Boleto;20/03/2026;autoeletricasaojudas3@gmail.com;FATURADO/FINALIZADO;Basic;Andreus
2/18/2026;POSTO GUAJARA LTDA;05.363.452/0002-32;FRANCY;91 8345-9800;15;Evo40;0;1150;99.9;Pix;20/03/2026;francy_silva3@hotmail.com;FATURADO/FINALIZADO;Basic;Andreus
2/18/2026;LABCLIN CONSULTAS E DIAGNOSTICOS LTDA;06.208.484/0001-45;Lane;91 8177-6483;25;Evo40;0;1150;169;Boleto;20/03/2026;francy_silva3@hotmail.com;FATURADO/FINALIZADO;Pro;Andreus
2/19/2026;THECA ANALISES PETROQUIMICAS LTDA;22.899.346/0001-06;Fernando;34 9646-3726;30;Tablet;0;0;280;Boleto;15/03/2026;thecalaboratorio@gmail.com;FATURADO/FINALIZADO;Ultimate;Nicolas
2/20/2026;PIZZARIA E RESTAURANTE EDINHO LTDA;39.610.168/0001-54;EDME;11 94005-3233;10;Evo40;0;1150;69.9;Boleto;01/03/2026;Restauranteedinho@hotmail.com;FATURADO/FINALIZADO;Basic;Andreus
2/24/2026;FABIO FONTES OLIVEIRA;13.169.864/0001-83;FABIO;15 99713-1320;20;Celular;0;0;119;Boleto;15/03/2026;futcraques2011@hotmail.com;FATURADO/FINALIZADO;Pro;Nicolas
2/26/2026;NUCLEO INFANTIL ESTILO S/S LTDA;67.133.231/0001-44;PAULO;11 95849-0864;20;Evo40;0;1150;129;Boleto;03/04/2026;nogueira-ph@uol.com.br;FATURADO/FINALIZADO;Basic;Andreus
2/26/2026;CAPITAL BALANCAS E ASSISTENCIA TECNICA LTDA;01.185.869/0001-10;TANIA;11 94796-3402;20;Celular;0;0;129;Boleto;05/03/2026;tania@capitalbalancas.com.br;FATURADO/FINALIZADO;Ultimate;Andreus
3/4/2026;LAR FRATERNO SAO VICENTE DE PAULO DE APIAI;50.812.411/0001-50;Alaíme;15 99618-7409;25;Evo40;350;1450;149;Boleto;01/04/2026;asiloapiai@hotmail.com;FATURADO/FINALIZADO;Pro;Andreus
3/5/2026;RINOMAK MAQUINAS E SERVICOS LTDA;57.189.739/0001-00;SANDRO;16 99399-7135;10;Celular;0;0;99.9;Boleto;16/03/2026;vendas@rinomak.com;FATURADO/FINALIZADO;Ultimate;Andreus
3/6/2026;P.C.C. ALVES OTICA LTDA OTICAS CAROL;04.320.265/0001-28;Wânia;15 99733-3546;25;Celular;0;0;189;Boleto;03/04/2026;Paulo.ciconini@oticascarol.com.br;FATURADO/FINALIZADO;Ultimate;Andreus
3/6/2026;A.M.S. TRANSPORTES RODOVIARIOS DE CARGAS LTDA;39.486.052/0001-55;Luciano;15 99849-5566;70;Evo40;0;1450;350;Boleto;10/04/2026;financeiro@amstransportes.log.br;FATURADO/FINALIZADO;Pro;Nicolas
3/14/2026;DAYANA SA SILVA SANTANA;58.031.863/0001-06;PATRIK;11 94450-6441;5;Celular;0;0;69.9;Boleto;15/04/2026;Blend_pants@gmail.com;FATURADO/FINALIZADO;Ultimate;Andreus
3/23/2026;ESPACO GOURMET ITACIMIRIM LTDA;57.748.223/0001-59;TATIANA;71 9674-0709;20;Celular;0;0;149.9;Boleto;05/04/2026;donaflor.rh@gmail.com;FATURADO/FINALIZADO;Ultimate;Andreus
3/25/2026;CLINICA AMOR SAUDE DIAS DAVILA;60.238.577/0001-68;Nathalia;71 8391-6279;20;Evo40;1090;0;69.9;Pix;10/04/2026;financ.diasdavila.ba@amorsaude.com;FATURADO/FINALIZADO;Basic;Andreus
3/31/2026;MERIDIAN CONSTRUCOES E SERVICOS LTDA;34.308.156/0001-56;Lidiane;62 9446-6265;110;Evo40;0;11928;489;Boleto;15/05/2026;meridian.financeiro@gmail.com;FATURADO/FINALIZADO;Pro;Andreus
3/31/2026;GOULART E JAQUES LTDA;93.072.056/0001-32;Fernando;55 9934-9604;20;Evo40;0;1150;129;Pix;05/05/2026;hotelsaojorge@outlook.com;FATURADO/FINALIZADO;Pro;Andreus
4/6/2026;ARAUJO TECNOLOGIA E AUTOMACAO INDUSTRIAL LTDA;41.371.390/0001-93;MARAIZA;11 97455-9288;40;Celular;0;0;200;Boleto;15/04/2026;araujotecnologiaindustrial@gmail.com;FATURADO/FINALIZADO;Pro;Nicolas
4/6/2026;CASA VERONA CAFE LTDA;53.216.093/0001-52;Gabriela;19 99900-5770;20;Evo40;0;1305;115;Boleto;15/04/2026;gabrielavcomin@gmail.com;FATURADO/FINALIZADO;Pro;Nicolas
4/8/2026;Campo limpo projetos e serviços ltda;22.142.333/0001-98;Rafael;15 99841-4346;5;Evo40;250;1232;69.9;A vista;15/04/2026;rafaellm@campolimpo.com.br;FATURADO/FINALIZADO;Pro;Oséias
4/9/2026;FONCECA ENGENHARIA LTDA;50.677.831/0001-70;Raphael;47 93505-9717;15;Celular;0;0;99.9;Boleto;15/04/2026;comercial@foncecaengenharia.com.br;FATURADO/FINALIZADO;Pro;Andreus
4/17/2026;M I MAQ LTDA;53.639.042/0001-33;Vitória;15 99813-0650;10;Celular;0;0;119.9;Boleto;15/05/2026;vitoria.mimaq@outlook.com;FATURADO/FINALIZADO;Ultimate;Matheus
4/20/2026;CONDOMINIO DO EDIFICIO SAINT JAQUES E SAINT ROMAIN;32.535.890/0001-22;André;21 96924-5825;5;Celular;0;0;69.9;Boleto;05/05/2026;andrebraga737@yahoo.com.br;FATURADO/FINALIZADO;Ultimate;Andreus
4/22/2026;BARBOSA WANDERLEY FARMACIA LTDA;38.047.152/0001-12;Victor;82 9131-3879;7;Evo40;0;1450;69.9;Cartão;15/05/2026;farmaformulafaroladm@gmail.com;FATURADO/FINALIZADO;Basic;Matheus
4/27/2026;TRIADE CONSTRUCOES E LOCACOES LTDA;26.155.740/0001-90;Maria;81 8292-7615;35;Celular;0;0;239.05;Boleto;02/05/2026;TRAOSCONSTRUCOES@GMAIL.COM;FATURADO/FINALIZADO;Ultimate;Andreus
4/28/2026;KOMPRAO COMERCIO DE ALIMENTOS LTDA;65.818.401/0001-07;SHIRLEY;15 99639-5739;30;Evo40;250;1232;189;Boleto;15/05/2026;komprao.rh@gmail.com;FATURADO/FINALIZADO;Pro;Andreus
4/29/2026;D & F INDUSTRIA E COMERCIO DE ALIMENTOS LTDA;34.168.082/0001-08;Rute;31 8859-0665;5;Evo40;0;1300;69.9;Boleto;15/05/2026;gostinhodeminas@yahoo.com;FATURADO/FINALIZADO;Ultimate;Nicolas
4/29/2026;GERAIS MOBILI COMERCIO LTDA;45.818.444/0001-77;Eder;81 9293-9064;20;Evo40;0;0;99.9;Boleto;15/05/2026;financeiro@geraismobili.com.br;FATURADO/FINALIZADO;Pro;Andreus
4/30/2026;Loja mel;18.706.001/0001-11;Chaoliang;15 99611-2266;5;Evo40;250;1450;69.9;Pix;30/04/2026;34983988@qq.com;FATURADO/FINALIZADO;Pro;Oséias
5/7/2026;PADARIA PIZZARIA E LANCHONETE TUPAO LTDA;09.318.088/0001-69;Geraldo;31 8723-9656;25;Evo40;0;1450;99.9;Cartão;05/06/2026;Geraldoclockwork@yahoo.com.br;FATURADO/FINALIZADO;Basic;Nicolas
5/7/2026;A.B.D SOTO ITAPEVA ME;04.031.775/0001-85;FELIPE;15 99759-4249;25;Evo40;150;1232;129;Boleto;05/06/2026;contato@srtruck.com.br;FATURADO/FINALIZADO;Basic;Andreus
5/7/2026;RET MHM mecanica LTDA;59.469.703/0001-06;MARCOS;21 99790-8289;5;Evo40;0;0;49.9;Boleto;20/05/2026;Msrcoshortadealmeida@gmail.com;FATURADO/FINALIZADO;Basic;Andreus
5/14/2026;JB ESTETICA CORPO E MENTE LTDA;61.708.800/0001;VICTORIA;11 96354-7061;5;Celular;0;0;69.9;Boleto;25/05/2026;jbestetica.estetica@gmail.com;FATURADO/FINALIZADO;Ultimate;Andreus
5/15/2026;VIME ACESSORIOS LTDA;46.022.185/0001-36;LUIZ;11 98593-6512;25;Celular;0;0;179;Boleto;25/05/2026;Vime.financeiro@gmail.com;FATURADO/FINALIZADO;Ultimate;Andreus
5/18/2026;FREITAS E LIBERTADOR LTDA;46.308.865/0001-10;KLEBER;75 9207-5069;5;Celular;0;0;69.9;Boleto;05/06/2026;diagrammeimpressos@gmail.com;FATURADO/FINALIZADO;Ultimate;Andreus
5/18/2026;ROVEIGA VIVEIRO FLORESTAL LTDA;17.141.560/0001-69;Elenice;15 99678-3457;70;Evo40;0;7080.06;310.8;Boleto;10/06/2026;finanroveiga@gmail.com;FATURADO/FINALIZADO;Pro;Nicolas
5/22/2026;PERFIL CUIDADOS E SERVICOS DE APOIO LTDA;18.635.654/0001-57;LEANDRO;11 98448-8664;10;Evo40;0;1150;89.9;Cartão;08/06/2026;leandro@centrodiaperfil.com.br;Aguardando faturamento;Basic;Andreus
5/22/2026;HOLANISCZ & HOLANISCZ LTDA;21.588.237/0001-05;INGRID;14 99898-4216;35;Celular;0;0;286.95;Boleto;05/06/2026;dp@holaniscz.com;FATURADO/FINALIZADO;Ultimate;Andreus
5/22/2026;TABACARIA ABC DELIVERY LTDA;46.038.051/0001-03;PEDRO;11 94553-0244;10;Celular;0;0;69.9;Boleto;28/05/2026;LPDISTRIBUIDORA24H@GMAIL.COM;Aguardando faturamento;Ultimate;Andreus
5/22/2026;NS ENGENHARIA;51.667.482/0001-79;Wilian;11 96058-9474;50;Já possui;0;0;360;Boleto;28/05/2026;financeiro@nsservicoselocacoes.com.br;Aguardando faturamento;Ultimate;Nicolas
5/22/2026;RAPHE MEDICAL LTDA;23.778.799/0001-47;Alberto;19 97406-4011;30;Evo40;0;2300;149;Boleto;10/06/2026;Rh@raphemedical.med.br;Aguardando faturamento;Basic;Andreus
5/22/2026;CASA DAS IMPRESSORAS E INFORMATICA LTDA;21.157.196/0001-00;MARCOS;38 9972-1418;10;Evo40;0;1150;50;Pix;15/06/2026;marcosunai2@hotmail.com;Aguardando faturamento;Basic;Andreus
5/25/2026;CONFIANCA CLIMATIZACAO E REFRIGERACAO LTDA;48.059.412/0001-23;LUCAS;51 8230-2505;5;Evo40;0;1150;69.9;Pix;05/06/2026;confiancaclimatizacao@outlook.com;Aguardando faturamento;Basic;Andreus
5/26/2026;COMERCIAL LAURINO LTDA;17.422.883/0001-20;LUCASS;12 99153-2455;5;Celular;0;0;69.9;Boleto;05/06/2026;lucas@grupolaurino.com.br;Aguardando faturamento;Pro;Andreus
5/28/2026;CERAMICA SOUZA LTDA;59.564.165/0001-39;NAYRANA;66 9251-6352;40;Evo40;0;2060;159;Boleto;15/06/2026;l.m.souzatransporte@gmail.com;Aguardando faturamento;Basic;Andreus
5/29/2026;VINICIUS HERNANE MEIRA POINT ARACATUBA;59.889.905/0001-07;Vanessa;18 99675-9530;10;Evo40;0;1150;89.9;Boleto;05/06/2026;vpereiradasilva757@gmail.com;Aguardando faturamento;Basic;Andreus
5/29/2026;LIRIOS CONFECCOES LTDA;61.261.225/0001-96;Welismar;62 9352-2703;20;Evo40;0;1150;149;Boleto;05/06/2026;Welismarfernandes.13@gmail.com;Aguardando faturamento;Basic;Andreus
5/29/2026;SHALOM ADONAI TRANSPORTES LTDA;55.039.852/0001-84;Alessandro;11 98906-8185;5;Celular;0;0;69.9;Boleto;10/06/2026;Alessandrosilvadossantoss9@gmail.com;Aguardando faturamento;Ultimate;Andreus
5/29/2026;AVANTE RIO COMERCIO DE LANCHES LTDA;49.783.272/0001-02;FELYPE;91 9215-0303;10;Evo40;0;1080;89.9;Boleto;10/06/2026;Felypebr09@gmail.com;Aguardando faturamento;Basic;Andreus
6/2/2026;Parys Souza da Fonseca;63.340.780-200;Parys;91 9142-6207;5;Celular;0;0;69.9;Boleto;10/06/2026;parys@paryspalm.com.br;Aguardando faturamento;Basic;Andreus`;

const CLIENTES_BASE = CSV_BASE.trim().split('\n').filter(l=>l.replace(/;/g,'').trim()).map((line,idx)=>{
  const c=line.split(';');
  const d=parseDate(c[0]);
  const vI=parseValor(c[7]),vE=parseValor(c[8]),vS=parseValor(c[9]);
  const fat=(c[13]||'').toUpperCase().includes('FATURADO')&&!(c[13]||'').toUpperCase().includes('AGUARDANDO');
  return{
    id:`base_${idx}`,_base:true,
    data:d,ano:d?d.getFullYear():null,mes:d?d.getMonth():null,
    nome:(c[1]||'').trim(),cnpj:(c[2]||'').trim(),contato:(c[3]||'').trim(),
    tel:(c[4]||'').trim(),func:parseInt(c[5])||0,equipTipo:(c[6]||'').trim(),
    vI,vE,vS,total:vI+vE+vS,
    pagamento:(c[10]||'').trim(),dtBoleto:(c[11]||'').trim(),email:(c[12]||'').trim(),
    status:fat?'Faturado':'Aguardando',plano:(c[14]||'').trim()||'—',
    vendedor:(c[15]||'').trim()||'—',nfe:'',renovacao:'',obs:''
  };
}).filter(c=>c.nome);


// --- LOGOS SVG ----------------------------------------------------------------
const LOGO_SIDEBAR_SVG=(
  <svg width="140" height="28" viewBox="0 0 140 28" fill="none" xmlns="http://www.w3.org/2000/svg">
    <g transform="translate(13,14)">
      <line x1="0" y1="-9" x2="0" y2="-5.5" stroke="#f5a623" strokeWidth="2.2" strokeLinecap="round"/>
      <line x1="0" y1="5.5" x2="0" y2="9" stroke="#f5a623" strokeWidth="2.2" strokeLinecap="round"/>
      <line x1="-9" y1="0" x2="-5.5" y2="0" stroke="#f5a623" strokeWidth="2.2" strokeLinecap="round"/>
      <line x1="5.5" y1="0" x2="9" y2="0" stroke="#f5a623" strokeWidth="2.2" strokeLinecap="round"/>
      <line x1="-6.4" y1="-6.4" x2="-3.9" y2="-3.9" stroke="#f5a623" strokeWidth="2.2" strokeLinecap="round"/>
      <line x1="3.9" y1="3.9" x2="6.4" y2="6.4" stroke="#f5a623" strokeWidth="2.2" strokeLinecap="round"/>
      <line x1="6.4" y1="-6.4" x2="3.9" y2="-3.9" stroke="#f5a623" strokeWidth="2.2" strokeLinecap="round"/>
      <line x1="-3.9" y1="3.9" x2="-6.4" y2="6.4" stroke="#f5a623" strokeWidth="2.2" strokeLinecap="round"/>
      <circle cx="0" cy="0" r="3.2" fill="#f5a623"/>
    </g>
    <text x="28" y="18.5" fontFamily="'Segoe UI',Arial,sans-serif" fontSize="13" fontWeight="300" letterSpacing="0.8" fill="#ffffff">secullum</text>
    <text x="105" y="18.5" fontFamily="'Segoe UI',Arial,sans-serif" fontSize="12" fontWeight="700" fill="#f5a623"> RH</text>
  </svg>
);
const LOGO_LOGIN_SVG=(
  <svg width="180" height="48" viewBox="0 0 180 48" fill="none" xmlns="http://www.w3.org/2000/svg">
    <g transform="translate(22,24)">
      <line x1="0" y1="-14" x2="0" y2="-8.5" stroke="#f5a623" strokeWidth="3.2" strokeLinecap="round"/>
      <line x1="0" y1="8.5" x2="0" y2="14" stroke="#f5a623" strokeWidth="3.2" strokeLinecap="round"/>
      <line x1="-14" y1="0" x2="-8.5" y2="0" stroke="#f5a623" strokeWidth="3.2" strokeLinecap="round"/>
      <line x1="8.5" y1="0" x2="14" y2="0" stroke="#f5a623" strokeWidth="3.2" strokeLinecap="round"/>
      <line x1="-9.9" y1="-9.9" x2="-6" y2="-6" stroke="#f5a623" strokeWidth="3.2" strokeLinecap="round"/>
      <line x1="6" y1="6" x2="9.9" y2="9.9" stroke="#f5a623" strokeWidth="3.2" strokeLinecap="round"/>
      <line x1="9.9" y1="-9.9" x2="6" y2="-6" stroke="#f5a623" strokeWidth="3.2" strokeLinecap="round"/>
      <line x1="-6" y1="6" x2="-9.9" y2="9.9" stroke="#f5a623" strokeWidth="3.2" strokeLinecap="round"/>
      <circle cx="0" cy="0" r="5" fill="#f5a623"/>
    </g>
    <text x="44" y="31" fontFamily="'Segoe UI',Arial,sans-serif" fontSize="22" fontWeight="300" letterSpacing="0.5" fill="#2c3e50">secullum</text>
    <text x="153" y="31" fontFamily="'Segoe UI',Arial,sans-serif" fontSize="17" fontWeight="700" fill="#f5a623">RH</text>
  </svg>
);

// --- TELA DE LOGIN ------------------------------------------------------------
function LoginScreen({onLogin}){
  const [email,setEmail]=useState('');
  const [senha,setSenha]=useState('');
  const [modo,setModo]=useState('login'); // login | criar
  const [erro,setErro]=useState('');
  const [loading,setLoading]=useState(false);
  const fi={padding:'10px 14px',borderRadius:6,border:'1px solid #dde1e7',fontSize:14,width:'100%',boxSizing:'border-box',marginBottom:12};

  async function handleLogin(e){
    e.preventDefault();setErro('');setLoading(true);
    try{
      await signInWithEmailAndPassword(auth,email,senha);
    }catch(err){
      setErro('Email ou senha incorretos.');
    }finally{setLoading(false);}
  }
  async function handleCriar(e){
    e.preventDefault();setErro('');setLoading(true);
    try{
      await createUserWithEmailAndPassword(auth,email,senha);
    }catch(err){
      setErro(err.code==='auth/email-already-in-use'?'Email já cadastrado.':'Erro ao criar conta. Verifique os dados.');
    }finally{setLoading(false);}
  }

  return(
    <div style={{minHeight:'100vh',background:'#2c3e50',display:'flex',alignItems:'center',justifyContent:'center',fontFamily:'sans-serif'}}>
      <div style={{background:'#fff',borderRadius:12,padding:'40px',width:'100%',maxWidth:380,boxShadow:'0 8px 32px rgba(0,0,0,.2)'}}>
        <div style={{textAlign:'center',marginBottom:28}}>
          <div style={{display:'flex',justifyContent:'center',marginBottom:12}}>{LOGO_LOGIN_SVG}</div>
          <div style={{fontSize:13,color:'#7f8c8d',marginTop:4}}>{modo==='login'?'Entre na sua conta':'Criar nova conta'}</div>
        </div>
        <form onSubmit={modo==='login'?handleLogin:handleCriar}>
          <input style={fi} type="email" placeholder="Email" value={email} onChange={e=>setEmail(e.target.value)} required/>
          <input style={fi} type="password" placeholder="Senha" value={senha} onChange={e=>setSenha(e.target.value)} required/>
          {erro&&<div style={{background:'#fee2e2',color:'#991b1b',padding:'8px 12px',borderRadius:6,fontSize:12,marginBottom:12}}>{erro}</div>}
          <button type="submit" disabled={loading} style={{width:'100%',padding:'12px',borderRadius:6,border:'none',background:'#3498db',color:'#fff',fontWeight:700,fontSize:14,cursor:'pointer'}}>
            {loading?'Aguarde...':(modo==='login'?'Entrar':'Criar conta')}
          </button>
        </form>
        <div style={{textAlign:'center',marginTop:16}}>
          <button onClick={()=>{setModo(m=>m==='login'?'criar':'login');setErro('');}} style={{background:'none',border:'none',color:'#3498db',cursor:'pointer',fontSize:13}}>
            {modo==='login'?'Criar nova conta':'Voltar para login'}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- COMPONENTES VISUAIS ------------------------------------------------------
function Donut({vals,colors,size=100,label,sub}){
  const tot=vals.reduce((s,v)=>s+v,0)||1;let a=-Math.PI/2;
  const cx=size/2,cy=size/2,r=size*.42,inn=size*.28;
  const paths=vals.map((v,i)=>{
    const sw=(v/tot)*2*Math.PI;if(sw<0.01)return null;
    const x1=cx+r*Math.cos(a),y1=cy+r*Math.sin(a);a+=sw;
    const x2=cx+r*Math.cos(a),y2=cy+r*Math.sin(a);
    const xi1=cx+inn*Math.cos(a-sw),yi1=cy+inn*Math.sin(a-sw);
    const xi2=cx+inn*Math.cos(a),yi2=cy+inn*Math.sin(a);
    const lg=sw>Math.PI?1:0;
    return <path key={i} d={`M${x1},${y1} A${r},${r} 0 ${lg},1 ${x2},${y2} L${xi2},${yi2} A${inn},${inn} 0 ${lg},0 ${xi1},${yi1} Z`} fill={colors[i]}/>;
  });
  return(
    <div style={{position:'relative',width:size,height:size,flexShrink:0}}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>{paths}<circle cx={cx} cy={cy} r={inn} fill={C.card}/></svg>
      {label&&<div style={{position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',textAlign:'center',lineHeight:1.2}}>
        <div style={{fontSize:size*.13,fontWeight:700,color:C.text}}>{label}</div>
        {sub&&<div style={{fontSize:size*.09,color:C.textMuted}}>{sub}</div>}
      </div>}
    </div>
  );
}

function BarChart({data,color,height=100}){
  const max=Math.max(...data.map(d=>d.v),1);
  return(
    <div style={{display:'flex',alignItems:'flex-end',gap:3,height,paddingTop:8}}>
      {data.map((d,i)=>(
        <div key={i} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:2}}>
          <div style={{width:'100%',background:color,borderRadius:'3px 3px 0 0',height:`${Math.max((d.v/max)*(height-20),d.v>0?3:0)}px`}}/>
          <div style={{fontSize:8,color:C.textMuted,textAlign:'center'}}>{d.l}</div>
        </div>
      ))}
    </div>
  );
}

function StatCard({icon,label,value,sub,color,pct,onClick}){
  return(
    <div onClick={onClick} style={{background:C.card,borderRadius:6,padding:'14px 16px',boxShadow:'0 1px 3px rgba(0,0,0,.08)',borderLeft:`4px solid ${color}`,cursor:onClick?'pointer':'default'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
        <div>
          <div style={{fontSize:11,color:C.textMuted,marginBottom:3,textTransform:'uppercase',letterSpacing:.5}}>{label}</div>
          <div style={{fontSize:20,fontWeight:700,color:C.text}}>{value}</div>
          {sub&&<div style={{fontSize:11,color:C.textMuted,marginTop:2}}>{sub}</div>}
        </div>
        <div style={{width:38,height:38,borderRadius:8,background:color,display:'flex',alignItems:'center',justifyContent:'center'}}>
          <i className={`ti ${icon}`} style={{fontSize:18,color:'#fff'}}/>
        </div>
      </div>
      {pct!==undefined&&(
        <div>
          <div style={{height:4,borderRadius:2,background:'#ecf0f1'}}>
            <div style={{height:'100%',borderRadius:2,background:color,width:`${Math.min(pct,100)}%`}}/>
          </div>
          <div style={{fontSize:10,color:C.textMuted,marginTop:2}}>{pct}% do total</div>
        </div>
      )}
    </div>
  );
}

// --- CARD DETALHE (IMPLANTAÇÃO) -----------------------------------------------
function CardDetalhe({cliente,implData,onSalvar,onVoltar,currentUser}){
  const fi={padding:'6px 10px',borderRadius:5,border:'1px solid #dde1e7',fontSize:12,color:'#2c3e50',background:'#fff',width:'100%',boxSizing:'border-box'};
  const [local,setLocal]=useState({etapa:'venda_fechada',prazo:'',comentarios:[],processos:[],arquivos:[],...implData});
  const [procText,setProcText]=useState('');
  const [comentario,setComentario]=useState('');
  const [saved,setSaved]=useState(false);

  function salvar(){onSalvar(cliente.id,local);setSaved(true);setTimeout(()=>setSaved(false),1800);}
  function addProc(){
    if(!procText.trim())return;
    const lbl=ETAPAS.find(e=>e.id===local.etapa)?.label||local.etapa;
    setLocal(l=>({...l,processos:[...(l.processos||[]),{texto:procText,data:new Date().toLocaleDateString('pt-BR'),usuario:currentUser?.nome||currentUser?.email||'—',etapa:lbl}]}));
    setProcText('');
  }
  function addComent(){
    if(!comentario.trim())return;
    setLocal(l=>({...l,comentarios:[...(l.comentarios||[]),{texto:comentario,data:new Date().toLocaleDateString('pt-BR'),usuario:currentUser?.nome||currentUser?.email||'—'}]}));
    setComentario('');
  }
  const etapaAtual=ETAPAS.find(e=>e.id===local.etapa);
  return(
    <div>
      <button onClick={onVoltar} style={{background:'none',border:'none',cursor:'pointer',color:'#3498db',fontSize:13,marginBottom:16,display:'flex',alignItems:'center',gap:6,padding:0}}>
        <i className="ti ti-arrow-left"/> Voltar ao Kanban
      </button>
      <div style={{background:'#fff',borderRadius:8,padding:'20px',boxShadow:'0 1px 3px rgba(0,0,0,.08)'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:14,flexWrap:'wrap',gap:8}}>
          <div>
            <div style={{fontWeight:700,fontSize:17,color:'#2c3e50',marginBottom:5}}>{cliente.nome}</div>
            <div style={{fontSize:11,color:'#7f8c8d'}}>{cliente.cnpj} • {cliente.contato} • {cliente.tel}</div>
          </div>
          <div style={{fontWeight:700,fontSize:18,color:'#3498db'}}>{moeda(cliente.total)}</div>
        </div>
        <div style={{background:'#f8f9fa',borderRadius:8,padding:'14px',marginBottom:14}}>
          <div style={{fontSize:11,color:'#7f8c8d',fontWeight:700,textTransform:'uppercase',marginBottom:10}}>Andamento</div>
          <div style={{display:'flex',gap:2,marginBottom:12,flexWrap:'wrap'}}>
            {ETAPAS.map((e,i)=>{const idx=ETAPAS.findIndex(x=>x.id===local.etapa);const done=i<idx,active=i===idx;
              return <div key={e.id} title={e.label} onClick={()=>setLocal(l=>({...l,etapa:e.id}))} style={{flex:1,height:8,borderRadius:4,background:active?e.color:done?e.color+'99':'#ecf0f1',cursor:'pointer',minWidth:16}}/>;
            })}
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
            <div>
              <label style={{fontSize:11,color:'#7f8c8d',display:'block',marginBottom:3,fontWeight:700,textTransform:'uppercase'}}>Etapa</label>
              <select value={local.etapa} onChange={e=>setLocal(l=>({...l,etapa:e.target.value}))} style={{...fi,borderLeft:`4px solid ${etapaAtual?.color||'#3498db'}`}}>
                {ETAPAS.map(e=><option key={e.id} value={e.id}>{e.label}</option>)}
              </select>
            </div>
            <div>
              <label style={{fontSize:11,color:'#7f8c8d',display:'block',marginBottom:3,fontWeight:700,textTransform:'uppercase'}}>Prazo</label>
              <input type="date" value={local.prazo||''} onChange={e=>setLocal(l=>({...l,prazo:e.target.value}))} style={fi}/>
            </div>
          </div>
        </div>
        <div style={{marginBottom:14}}>
          <div style={{fontWeight:700,fontSize:12,color:'#2c3e50',marginBottom:8,textTransform:'uppercase'}}>Processos</div>
          {(local.processos||[]).map((p,i)=>(
            <div key={i} style={{background:'#f8f9fa',borderRadius:5,padding:'8px 12px',marginBottom:4,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div><div style={{fontSize:12,fontWeight:600}}>{p.texto}</div><div style={{fontSize:10,color:'#7f8c8d'}}>{p.data} • {p.usuario}</div></div>
              <span style={{background:'#ebf5fb',color:'#3498db',padding:'2px 8px',borderRadius:10,fontSize:10,fontWeight:700,flexShrink:0,marginLeft:8}}>{p.etapa}</span>
            </div>
          ))}
          <div style={{display:'flex',gap:8,marginTop:6}}>
            <input value={procText} onChange={e=>setProcText(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addProc()} placeholder="Processo executado..." style={{...fi,flex:1}}/>
            <button onClick={addProc} style={{padding:'6px 12px',borderRadius:5,border:'none',background:'#3498db',color:'#fff',cursor:'pointer',fontSize:12,fontWeight:700}}>+ Add</button>
          </div>
        </div>
        <div style={{marginBottom:14}}>
          <div style={{fontWeight:700,fontSize:12,color:'#2c3e50',marginBottom:8,textTransform:'uppercase'}}>Arquivos</div>
          {(local.arquivos||[]).map((a,i)=>(
            <div key={i} style={{background:'#f0f9ff',borderRadius:5,padding:'6px 12px',marginBottom:4,display:'flex',justifyContent:'space-between',fontSize:12}}>
              <span><i className="ti ti-file" style={{marginRight:6,color:'#3498db'}}/>{a.nome}</span>
              <span style={{fontSize:10,color:'#7f8c8d'}}>{a.data}</span>
            </div>
          ))}
          <label style={{display:'inline-flex',alignItems:'center',gap:6,padding:'6px 14px',borderRadius:5,background:'#ecf0f1',cursor:'pointer',fontSize:12,fontWeight:600,color:'#2c3e50',marginTop:4}}>
            <i className="ti ti-upload"/><span>Anexar</span>
            <input type="file" style={{display:'none'}} onChange={e=>{const f=e.target.files[0];if(f)setLocal(l=>({...l,arquivos:[...(l.arquivos||[]),{nome:f.name,data:new Date().toLocaleDateString('pt-BR')}]}));e.target.value='';}}/>
          </label>
        </div>
        <div style={{marginBottom:16}}>
          <div style={{fontWeight:700,fontSize:12,color:'#2c3e50',marginBottom:8,textTransform:'uppercase'}}>Comentários</div>
          {(local.comentarios||[]).map((c,i)=>(
            <div key={i} style={{background:'#f8f9fa',borderRadius:5,padding:'8px 12px',marginBottom:4,borderLeft:'3px solid #3498db'}}>
              <div style={{fontSize:12}}>{c.texto}</div>
              <div style={{fontSize:10,color:'#7f8c8d',marginTop:3}}>{c.data} • {c.usuario}</div>
            </div>
          ))}
          <div style={{display:'flex',gap:8,marginTop:6}}>
            <input value={comentario} onChange={e=>setComentario(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addComent()} placeholder="Comentário..." style={{...fi,flex:1}}/>
            <button onClick={addComent} style={{padding:'6px 12px',borderRadius:5,border:'none',background:'#7f8c8d',color:'#fff',cursor:'pointer',fontSize:12,fontWeight:700}}>Enviar</button>
          </div>
        </div>
        <button onClick={salvar} style={{width:'100%',padding:'12px',borderRadius:6,border:'none',background:saved?'#27ae60':'#2c3e50',color:'#fff',fontWeight:700,cursor:'pointer',fontSize:14,display:'flex',alignItems:'center',justifyContent:'center',gap:8,transition:'background .3s'}}>
          <i className={`ti ${saved?'ti-check':'ti-device-floppy'}`}/>{saved?'Salvo! Kanban atualizado.':'Salvar e atualizar Kanban'}
        </button>
      </div>
    </div>
  );
}

// --- KANBAN VIEW --------------------------------------------------------------
function KanbanView({todos,implantacoes,onSalvarImpl,currentUser}){
  const [subAba,setSubAba]=useState('kanban');
  const [clienteKanban,setClienteKanban]=useState(null);
  const [filtroEtapa,setFiltroEtapa]=useState('Todos');
  const [dragId,setDragId]=useState(null);
  const [dragOver,setDragOver]=useState(null);
  const hoje=new Date();hoje.setHours(0,0,0,0);
  const hoje_str=hoje.toISOString().split('T')[0];
  const [mesC,setMesC]=useState(hoje.getMonth());
  const [anoC,setAnoC]=useState(hoje.getFullYear());

  function getImpl(id){return implantacoes[id]||{etapa:'venda_fechada',prazo:'',comentarios:[],processos:[],arquivos:[]};}
  const cards=todos.map(c=>({...c,impl:getImpl(c.id)}));
  const atrasados=cards.filter(c=>{const p=c.impl.prazo?new Date(c.impl.prazo):null;return p&&p<hoje&&c.impl.etapa!=='processo_finalizado';});
  const doDia=cards.filter(c=>c.impl.prazo===hoje_str&&c.impl.etapa!=='processo_finalizado');
  const pendentes=cards.filter(c=>c.impl.etapa!=='processo_finalizado');
  const diasNoMes=new Date(anoC,mesC+1,0).getDate();
  const primeiroDia=new Date(anoC,mesC,1).getDay();
  const eventosMes=cards.filter(c=>{if(!c.impl.prazo)return false;const d=new Date(c.impl.prazo);return d.getMonth()===mesC&&d.getFullYear()===anoC;});
  const fi={padding:'6px 10px',borderRadius:5,border:'1px solid #dde1e7',fontSize:12,color:'#2c3e50',background:'#fff',width:'100%',boxSizing:'border-box'};

  if(clienteKanban){
    return <CardDetalhe cliente={clienteKanban} implData={getImpl(clienteKanban.id)} onSalvar={(id,data)=>{onSalvarImpl(id,data);setClienteKanban(c=>({...c,impl:data}));}} onVoltar={()=>setClienteKanban(null)} currentUser={currentUser}/>;
  }

  const subAbas=[
    {id:'kanban',icon:'ti-layout-kanban',l:'Kanban'},
    {id:'hoje',icon:'ti-calendar-event',l:`Hoje (${doDia.length})`},
    {id:'pendentes',icon:'ti-clock',l:`Pendentes (${pendentes.length})`},
    {id:'atrasados',icon:'ti-alert-circle',l:`Atrasados (${atrasados.length})`},
    {id:'calendario',icon:'ti-calendar',l:'Calendário'},
  ];

  return(
    <div>
      <div style={{display:'flex',gap:6,marginBottom:16,flexWrap:'wrap',alignItems:'center'}}>
        {subAbas.map(s=>(
          <button key={s.id} onClick={()=>setSubAba(s.id)} style={{padding:'6px 14px',borderRadius:5,border:'none',background:subAba===s.id?'#3498db':'#ecf0f1',color:subAba===s.id?'#fff':'#2c3e50',cursor:'pointer',fontSize:12,fontWeight:600,display:'flex',alignItems:'center',gap:5}}>
            <i className={`ti ${s.icon}`}/>{s.l}
          </button>
        ))}
        {subAba==='kanban'&&(
          <>
            <select value={filtroEtapa} onChange={e=>setFiltroEtapa(e.target.value)} style={{...fi,width:'auto',marginLeft:'auto',padding:'6px 10px'}}>
              <option value="Todos">Todas etapas</option>
              {ETAPAS.map(e=><option key={e.id} value={e.id}>{e.label}</option>)}
            </select>
            <div style={{fontSize:10,color:'#7f8c8d'}}>← arraste para mover →</div>
          </>
        )}
      </div>

      {subAba==='kanban'&&(
        <div style={{overflowX:'auto',paddingBottom:8}}>
          <div style={{display:'flex',gap:10,minWidth:'max-content'}}>
            {ETAPAS.filter(e=>filtroEtapa==='Todos'||e.id===filtroEtapa).map(etapa=>{
              const cols=cards.filter(c=>c.impl.etapa===etapa.id);
              const isOver=dragOver===etapa.id;
              return(
                <div key={etapa.id} style={{width:200,flexShrink:0}}
                  onDragOver={e=>{e.preventDefault();setDragOver(etapa.id);}}
                  onDrop={e=>{e.preventDefault();if(dragId!==null){onSalvarImpl(dragId,{...getImpl(dragId),etapa:etapa.id});}setDragId(null);setDragOver(null);}}
                  onDragLeave={()=>setDragOver(null)}>
                  <div style={{background:etapa.color,color:'#fff',padding:'8px 10px',borderRadius:'8px 8px 0 0',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                    <span style={{fontSize:11,fontWeight:700,lineHeight:1.2}}>{etapa.label}</span>
                    <span style={{background:'rgba(255,255,255,.3)',borderRadius:10,padding:'1px 7px',fontSize:11,fontWeight:700,marginLeft:4}}>{cols.length}</span>
                  </div>
                  <div style={{background:isOver?'#d6eaf8':'#f0f2f5',borderRadius:'0 0 8px 8px',minHeight:140,padding:8,display:'flex',flexDirection:'column',gap:6,border:isOver?`2px dashed ${etapa.color}`:'2px solid transparent'}}>
                    {cols.map(c=>{
                      const prazoD=c.impl.prazo?new Date(c.impl.prazo):null;
                      const atrasado=prazoD&&prazoD<hoje;
                      const faturado=!!c.asaas_id;
                      // Dias na etapa atual
                      const diasNaEtapa=(()=>{
                        if(!c.impl.etapaData)return null;
                        const diff=Math.floor((Date.now()-new Date(c.impl.etapaData).getTime())/(1000*60*60*24));
                        return diff;
                      })();
                      const alerta7dias=diasNaEtapa!==null&&diasNaEtapa>=7;
                      return(
                        <div key={c.id}
                          draggable
                          onDragStart={e=>{setDragId(c.id);e.dataTransfer.effectAllowed='move';}}
                          onDragEnd={()=>{setDragId(null);setDragOver(null);}}
                          onClick={()=>setClienteKanban(c)}
                          style={{
                            background:faturado?'#fff5f5':'#fff',
                            borderRadius:6,
                            padding:'10px',
                            cursor:'grab',
                            boxShadow:dragId===c.id?'0 4px 12px rgba(0,0,0,.2)':'0 1px 3px rgba(0,0,0,.08)',
                            borderLeft:`3px solid ${faturado?'#e74c3c':etapa.color}`,
                            border:faturado?'2px solid #e74c3c':`1px solid transparent`,
                            opacity:dragId===c.id?.5:1
                          }}>
                          {faturado&&(
                            <div style={{background:'#e74c3c',color:'#fff',borderRadius:4,padding:'2px 6px',fontSize:9,fontWeight:700,marginBottom:4,display:'inline-block'}}>
                              ⚡ FATURADO — PRIORIDADE TOTAL
                            </div>
                          )}
                          <div style={{fontSize:11,fontWeight:700,color:'#2c3e50',marginBottom:3,lineHeight:1.3}}>{c.nome}</div>
                          {c.vendedor!=='—'&&<div style={{fontSize:10,color:'#7f8c8d',marginBottom:2}}>👤 {c.vendedor}</div>}
                          {c.impl.prazo&&<div style={{fontSize:10,color:atrasado?'#e74c3c':'#27ae60',fontWeight:600}}>📅 {new Date(c.impl.prazo+'T12:00:00').toLocaleDateString('pt-BR')}{atrasado?' ⚠':''}</div>}
                          {diasNaEtapa!==null&&(
                            <div style={{fontSize:9,color:alerta7dias?'#e74c3c':'#7f8c8d',fontWeight:alerta7dias?700:400,marginTop:2}}>
                              {alerta7dias?'⚠ ':'⏱ '}{diasNaEtapa}d nesta etapa
                            </div>
                          )}
                          {(c.impl.comentarios||[]).length>0&&<div style={{fontSize:10,color:'#7f8c8d',marginTop:2}}>💬 {c.impl.comentarios.length}</div>}
                          <div style={{fontSize:9,color:'#bdc3c7',marginTop:3,textAlign:'right'}}>⠿ arrastar</div>
                        </div>
                      );
                    })}
                    {cols.length===0&&<div style={{fontSize:11,color:'#bdc3c7',textAlign:'center',padding:'20px 0'}}>{isOver?'Solte aqui':'Vazio'}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {['hoje','pendentes','atrasados'].includes(subAba)&&(()=>{
        const lista=subAba==='hoje'?doDia:subAba==='pendentes'?pendentes:atrasados;
        const cor=subAba==='atrasados'?'#e74c3c':subAba==='hoje'?'#3498db':'#e67e22';
        return(
          <div>
            {lista.length===0&&<div style={{background:'#fff',borderRadius:8,padding:'30px',textAlign:'center',color:'#7f8c8d',fontSize:13}}>Nenhum item encontrado.</div>}
            {lista.map(c=>{
              const etapa=ETAPAS.find(e=>e.id===c.impl.etapa);
              return(
                <div key={c.id} onClick={()=>setClienteKanban(c)} style={{background:'#fff',borderRadius:8,padding:'12px 16px',marginBottom:8,cursor:'pointer',boxShadow:'0 1px 3px rgba(0,0,0,.06)',display:'flex',justifyContent:'space-between',alignItems:'center',borderLeft:`4px solid ${etapa?.color||cor}`}}>
                  <div>
                    <div style={{fontWeight:700,fontSize:13,color:'#2c3e50',marginBottom:3}}>{c.nome}</div>
                    <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                      <span style={{background:etapa?.color||'#ecf0f1',color:'#fff',padding:'2px 8px',borderRadius:10,fontSize:10,fontWeight:700}}>{etapa?.label}</span>
                      {c.impl.prazo&&<span style={{fontSize:11,color:subAba==='atrasados'?'#e74c3c':'#7f8c8d'}}>📅 {new Date(c.impl.prazo+'T12:00:00').toLocaleDateString('pt-BR')}</span>}
                      {c.vendedor!=='—'&&<span style={{fontSize:11,color:'#7f8c8d'}}>👤 {c.vendedor}</span>}
                    </div>
                  </div>
                  <div style={{fontWeight:700,color:'#3498db',fontSize:13}}>{moeda(c.total)}</div>
                </div>
              );
            })}
          </div>
        );
      })()}

      {subAba==='calendario'&&(
        <div style={{background:'#fff',borderRadius:8,padding:'16px',boxShadow:'0 1px 3px rgba(0,0,0,.08)'}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
            <button onClick={()=>{let m=mesC-1,a=anoC;if(m<0){m=11;a--;}setMesC(m);setAnoC(a);}} style={{background:'#ecf0f1',border:'none',borderRadius:5,padding:'5px 14px',cursor:'pointer',fontSize:16,fontWeight:700}}>‹</button>
            <div style={{fontWeight:700,fontSize:15,color:'#2c3e50'}}>{MESES[mesC]} {anoC}</div>
            <button onClick={()=>{let m=mesC+1,a=anoC;if(m>11){m=0;a++;}setMesC(m);setAnoC(a);}} style={{background:'#ecf0f1',border:'none',borderRadius:5,padding:'5px 14px',cursor:'pointer',fontSize:16,fontWeight:700}}>›</button>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:2,marginBottom:4}}>
            {['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'].map(d=><div key={d} style={{textAlign:'center',fontSize:10,fontWeight:700,color:'#7f8c8d',padding:'4px 0'}}>{d}</div>)}
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:2}}>
            {Array.from({length:primeiroDia}).map((_,i)=><div key={`e${i}`}/>)}
            {Array.from({length:diasNoMes}).map((_,i)=>{
              const dia=i+1;
              const dataStr=`${anoC}-${String(mesC+1).padStart(2,'0')}-${String(dia).padStart(2,'0')}`;
              const eventos=eventosMes.filter(c=>c.impl.prazo===dataStr);
              const isHoje=dia===hoje.getDate()&&mesC===hoje.getMonth()&&anoC===hoje.getFullYear();
              return(
                <div key={dia} style={{minHeight:56,background:isHoje?'#ebf5fb':'#f8f9fa',borderRadius:5,padding:'4px 5px',border:isHoje?'2px solid #3498db':'1px solid #ecf0f1'}}>
                  <div style={{fontSize:11,fontWeight:isHoje?700:400,color:isHoje?'#3498db':'#2c3e50',marginBottom:2}}>{dia}</div>
                  {eventos.slice(0,2).map(c=>{const etapa=ETAPAS.find(e=>e.id===c.impl.etapa);
                    return <div key={c.id} onClick={()=>setClienteKanban(c)} style={{background:etapa?.color||'#3498db',color:'#fff',borderRadius:3,padding:'1px 4px',fontSize:9,fontWeight:700,cursor:'pointer',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginBottom:1}}>{c.nome}</div>;
                  })}
                  {eventos.length>2&&<div style={{fontSize:9,color:'#7f8c8d'}}>+{eventos.length-2}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// --- FORMULÁRIO NOVO CLIENTE --------------------------------------------------
function NovoForm({onSave,onCancel,vendedoresCad,equipamentosCad,dadosImportados,currentUser}){
  const hoje=new Date();
  const equipDefault=equipamentosCad.length>0?equipamentosCad[0].nome:'Evo40';
  const hojeISO=`${hoje.getFullYear()}-${String(hoje.getMonth()+1).padStart(2,'0')}-${String(hoje.getDate()).padStart(2,'0')}`;
  // Preenche vendedor com usuário logado
  const nomeLogado=currentUser?.nome||currentUser?.email?.split('@')[0]||'';
  const [f,setF]=useState({
    data:hojeISO,
    nome:dadosImportados?.nome||'',
    empresa:dadosImportados?.empresa||'',
    cnpj:dadosImportados?.cnpj||'',
    contato:dadosImportados?.contato||'',
    tel:dadosImportados?.tel||'',
    fone:'',
    email:dadosImportados?.email||'',
    cep:'',rua:'',numero:'',complemento:'',bairro:'',cidade:'',
    inscMunicipal:'',inscEstadual:'',
    func:dadosImportados?.func||'',
    equipTipo:dadosImportados?.equipTipo||equipDefault,
    vI:dadosImportados?.vI||'',
    vE:dadosImportados?.vE||'',
    vS:dadosImportados?.vS||'',
    pagamento:'Boleto',
    dtBoleto:dadosImportados?.dtBoleto||'',
    status:'Aguardando',
    plano:dadosImportados?.plano||'Basic',
    vendedor:dadosImportados?.vendedor||nomeLogado,
    nfe:dadosImportados?.nfe||'Não',
    renovacao:'',
    obs:dadosImportados?.obs||'',
    despachado:'Não',
    equipRastreio:'',
    equipDataEnvio:'',
    pagamentoI:dadosImportados?.pagamentoI||'Boleto',
    parcelasI:dadosImportados?.parcelasI||1,
    pagamentoE:dadosImportados?.pagamentoE||'Boleto',
    parcelasE:dadosImportados?.parcelasE||1,
  });
  const up=(k,v)=>setF(x=>({...x,[k]:v}));
  const tot=(parseValor(f.vI)||0)+(parseValor(f.vE)||0)+(parseValor(f.vS)||0);
  const equipSel=equipamentosCad.find(e=>e.nome===f.equipTipo);
  const requerPag=equipSel?equipSel.requerPagamento:false;
  const [erros,setErros]=useState({});

  function validar(){
    const e={};
    if(!f.nome.trim())e.nome='Obrigatório';
    if(!f.empresa.trim())e.empresa='Obrigatório';
    if(!f.cnpj.trim())e.cnpj='Obrigatório';
    if(!f.tel.trim())e.tel='Obrigatório';
    if(!f.email.trim())e.email='Obrigatório';
    if(!f.cep.trim())e.cep='Obrigatório';
    if(!f.rua.trim())e.rua='Obrigatório';
    if(!f.numero.trim())e.numero='Obrigatório';
    if(!f.bairro.trim())e.bairro='Obrigatório';
    if(!f.cidade.trim())e.cidade='Obrigatório';
    if(!f.plano)e.plano='Obrigatório';
    if(!f.equipTipo)e.equipTipo='Obrigatório';
    if(!f.vendedor||f.vendedor==='—')e.vendedor='Obrigatório';
    if(!f.vS&&parseValor(f.vS)===0)e.vS='Informe o valor';
    setErros(e);
    return Object.keys(e).length===0;
  }
  function salvar(){
    if(!validar())return;
    const d=f.data?new Date(f.data+'T12:00:00'):null;
    const vI=parseValor(f.vI),vE=parseValor(f.vE),vS=parseValor(f.vS);
    onSave({_base:false,data:d,ano:d?d.getFullYear():null,mes:d?d.getMonth():null,
      nome:f.nome.trim().toUpperCase(),empresa:f.empresa.trim().toUpperCase(),
      cnpj:f.cnpj.trim().toUpperCase(),
      contato:f.contato.trim().toUpperCase(),tel:f.tel.trim(),fone:f.fone.trim(),
      email:f.email.trim(),
      cep:f.cep.trim(),rua:f.rua.trim().toUpperCase(),numero:f.numero.trim(),
      complemento:f.complemento.trim().toUpperCase(),bairro:f.bairro.trim().toUpperCase(),
      cidade:f.cidade.trim().toUpperCase(),
      inscMunicipal:f.inscMunicipal.trim(),inscEstadual:f.inscEstadual.trim(),
      func:parseInt(f.func)||0,equipTipo:f.equipTipo,vI,vE,vS,total:vI+vE+vS,
      pagamento:f.pagamento,dtBoleto:f.dtBoleto,
      status:f.status,plano:f.plano,vendedor:f.vendedor||'—',nfe:f.nfe,
      renovacao:f.renovacao,obs:f.obs,
      despachado:f.despachado,equipRastreio:f.equipRastreio.trim(),equipDataEnvio:f.equipDataEnvio,
      pagamentoI:f.pagamentoI,parcelasI:f.parcelasI,pagamentoE:f.pagamentoE,parcelasE:f.parcelasE,
    });
  }
  const fi={padding:'7px 10px',borderRadius:5,border:'1px solid #dde1e7',fontSize:13,color:'#2c3e50',background:'#fff',width:'100%',boxSizing:'border-box'};
  const fiErr=(k)=>({...fi,border:erros[k]?'1px solid #e74c3c':'1px solid #dde1e7',background:erros[k]?'#fff5f5':'#fff'});
  const lbl={fontSize:11,color:'#7f8c8d',display:'block',marginBottom:3,fontWeight:700,textTransform:'uppercase',letterSpacing:.4};
  const sec={background:C.card,borderRadius:8,padding:'16px',marginBottom:12,boxShadow:'0 1px 3px rgba(0,0,0,.06)'};
  const listaVendedores=vendedoresCad.length>0?vendedoresCad.map(v=>v.nome):[...new Set(CLIENTES_BASE.map(c=>c.vendedor).filter(v=>v&&v!=='—'))].sort();
  const listaEquips=equipamentosCad.length>0?equipamentosCad.map(e=>e.nome):EQUIPS;

  return(
    <div style={{fontFamily:'sans-serif'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
        <div style={{fontWeight:700,fontSize:16,color:C.text}}>
          {dadosImportados?'📥 Cliente importado do orçamento':'Novo cliente'}
        </div>
        <button onClick={onCancel} style={{background:'none',border:'none',cursor:'pointer',color:C.textMuted,fontSize:13}}>← Voltar</button>
      </div>
      {dadosImportados&&(
        <div style={{background:'#d5f5e3',border:'1px solid #27ae60',borderRadius:8,padding:'10px 16px',marginBottom:16,display:'flex',alignItems:'center',gap:10}}>
          <span style={{fontSize:18}}>✅</span>
          <div>
            <div style={{fontWeight:700,fontSize:12,color:'#1a5e34'}}>Dados importados do orçamento</div>
            <div style={{fontSize:11,color:'#27ae60'}}>Verifique e complete os campos faltantes antes de salvar</div>
          </div>
        </div>
      )}

      {/* Dados da empresa */}
      <div style={sec}>
        <div style={{fontWeight:700,fontSize:12,color:'#3498db',marginBottom:12,textTransform:'uppercase'}}>Dados do cliente</div>
        <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:10,marginBottom:10}}>
          <div><label style={{...lbl,color:erros.nome?'#e74c3c':'#7f8c8d'}}>{erros.nome?'Nome — '+erros.nome:'Nome *'}</label><input style={{...fiErr('nome'),textTransform:'uppercase'}} value={f.nome} onChange={e=>up('nome',e.target.value.toUpperCase())}/></div>
          <div><label style={lbl}>Data da venda</label><input style={fi} type="date" value={f.data} onChange={e=>up('data',e.target.value)}/></div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
          <div><label style={{...lbl,color:erros.empresa?'#e74c3c':'#7f8c8d'}}>{erros.empresa?'Empresa — '+erros.empresa:'Empresa / Razão Social *'}</label><input style={{...fiErr('empresa'),textTransform:'uppercase'}} value={f.empresa} onChange={e=>up('empresa',e.target.value.toUpperCase())}/></div>
          <div><label style={{...lbl,color:erros.cnpj?'#e74c3c':'#7f8c8d'}}>{erros.cnpj?'CNPJ/CPF — '+erros.cnpj:'CNPJ/CPF *'}</label><input style={{...fiErr('cnpj'),textTransform:'uppercase'}} value={f.cnpj} onChange={e=>up('cnpj',e.target.value.toUpperCase())}/></div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
          <div><label style={{...lbl,color:erros.email?'#e74c3c':'#7f8c8d'}}>{erros.email?'Email — '+erros.email:'Email financeiro *'}</label><input style={fiErr('email')} type="email" value={f.email} onChange={e=>up('email',e.target.value)}/></div>
          <div><label style={lbl}>Contato</label><input style={{...fi,textTransform:'uppercase'}} value={f.contato} onChange={e=>up('contato',e.target.value.toUpperCase())}/></div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10,marginBottom:10}}>
          <div><label style={{...lbl,color:erros.tel?'#e74c3c':'#7f8c8d'}}>{erros.tel?'Celular — '+erros.tel:'Celular *'}</label><input style={fiErr('tel')} value={f.tel} onChange={e=>up('tel',mascaraTel(e.target.value))} placeholder="(00) 00000-0000" maxLength={15}/></div>
          <div><label style={lbl}>Fone fixo</label><input style={fi} value={f.fone} onChange={e=>up('fone',mascaraTel(e.target.value))} placeholder="(00) 0000-0000" maxLength={14}/></div>
          <div><label style={lbl}>Funcionários</label><input style={fi} type="number" value={f.func} onChange={e=>up('func',e.target.value)}/></div>
        </div>
        {/* Endereço */}
        <div style={{borderTop:'1px solid #e8eaed',paddingTop:10,marginTop:4}}>
          <div style={{fontSize:11,fontWeight:700,color:'#7f8c8d',marginBottom:8,textTransform:'uppercase'}}>Endereço</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 2fr 1fr',gap:10,marginBottom:10}}>
            <div><label style={{...lbl,color:erros.cep?'#e74c3c':'#7f8c8d'}}>{erros.cep?'CEP — '+erros.cep:'CEP *'}</label><input style={fiErr('cep')} value={f.cep} onChange={e=>up('cep',e.target.value)} placeholder="00000-000" maxLength={9}/></div>
            <div><label style={{...lbl,color:erros.rua?'#e74c3c':'#7f8c8d'}}>{erros.rua?'Rua — '+erros.rua:'Rua *'}</label><input style={{...fiErr('rua'),textTransform:'uppercase'}} value={f.rua} onChange={e=>up('rua',e.target.value.toUpperCase())}/></div>
            <div><label style={{...lbl,color:erros.numero?'#e74c3c':'#7f8c8d'}}>{erros.numero?'Nº — '+erros.numero:'Número *'}</label><input style={fiErr('numero')} value={f.numero} onChange={e=>up('numero',e.target.value)}/></div>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10,marginBottom:10}}>
            <div><label style={lbl}>Complemento</label><input style={{...fi,textTransform:'uppercase'}} value={f.complemento} onChange={e=>up('complemento',e.target.value.toUpperCase())}/></div>
            <div><label style={{...lbl,color:erros.bairro?'#e74c3c':'#7f8c8d'}}>{erros.bairro?'Bairro — '+erros.bairro:'Bairro *'}</label><input style={{...fiErr('bairro'),textTransform:'uppercase'}} value={f.bairro} onChange={e=>up('bairro',e.target.value.toUpperCase())}/></div>
            <div><label style={{...lbl,color:erros.cidade?'#e74c3c':'#7f8c8d'}}>{erros.cidade?'Cidade — '+erros.cidade:'Cidade *'}</label><input style={{...fiErr('cidade'),textTransform:'uppercase'}} value={f.cidade} onChange={e=>up('cidade',e.target.value.toUpperCase())}/></div>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
            <div><label style={lbl}>Inscrição Municipal</label><input style={fi} value={f.inscMunicipal} onChange={e=>up('inscMunicipal',e.target.value)}/></div>
            <div><label style={lbl}>Inscrição Estadual</label><input style={fi} value={f.inscEstadual} onChange={e=>up('inscEstadual',e.target.value)}/></div>
          </div>
        </div>
      </div>

      {/* Produtos e valores */}
      <div style={sec}>
        <div style={{fontWeight:700,fontSize:12,color:'#e67e22',marginBottom:12,textTransform:'uppercase'}}>Produtos e valores</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
          <div>
            <label style={{...lbl,color:erros.equipTipo?'#e74c3c':'#7f8c8d'}}>{erros.equipTipo?'Equipamento — '+erros.equipTipo:'Equipamento *'}</label>
            <select style={fiErr('equipTipo')} value={f.equipTipo} onChange={e=>up('equipTipo',e.target.value)}>
              <option value="">— Selecione —</option>
              {listaEquips.map(e=><option key={e}>{e}</option>)}
            </select>
          </div>
          <div><label style={lbl}>Implantação (R$)</label><input style={fi} type="number" step="0.01" value={f.vI} onChange={e=>up('vI',e.target.value)} placeholder="0,00"/></div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
          <div><label style={lbl}>Equipamento (R$)</label><input style={fi} type="number" step="0.01" value={f.vE} onChange={e=>up('vE',e.target.value)} placeholder="0,00"/></div>
          <div><label style={{...lbl,color:erros.vS?'#e74c3c':'#7f8c8d'}}>{erros.vS?'Sistema/mês — '+erros.vS:'Sistema/mês (R$) *'}</label><input style={fiErr('vS')} type="number" step="0.01" value={f.vS} onChange={e=>up('vS',e.target.value)} placeholder="0,00"/></div>
        </div>
        <div style={{background:'#ebf5fb',borderRadius:6,padding:'10px 14px',display:'flex',justifyContent:'space-between'}}>
          <span style={{fontSize:13,color:C.textMuted,fontWeight:600}}>TOTAL</span>
          <span style={{fontSize:18,fontWeight:700,color:'#3498db'}}>{moeda(tot)}</span>
        </div>
      </div>

      {/* Pagamento por cobrança */}
      <div style={sec}>
        <div style={{fontWeight:700,fontSize:12,color:'#27ae60',marginBottom:12,textTransform:'uppercase'}}>💳 Formas de pagamento</div>

        {/* Implantação */}
        {parseValor(f.vI)>0&&(
          <div style={{background:'#fff8ee',borderRadius:8,padding:'12px',marginBottom:10,border:'1px solid #fde68a'}}>
            <div style={{fontWeight:700,fontSize:11,color:'#b45309',marginBottom:8}}>🔧 Implantação — {moeda(parseValor(f.vI))}</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
              <div><label style={lbl}>Forma</label>
                <select style={fi} value={f.pagamentoI} onChange={e=>{up('pagamentoI',e.target.value);if(e.target.value==='Pix')up('parcelasI',1);}}>
                  {FORMAS_ASAAS.map(x=><option key={x}>{x}</option>)}
                </select>
              </div>
              <div><label style={lbl}>Parcelas</label>
                <select style={fi} value={f.parcelasI} onChange={e=>up('parcelasI',+e.target.value)} disabled={f.pagamentoI==='Pix'}>
                  {[1,2,3].map(n=><option key={n} value={n}>{n}x</option>)}
                </select>
              </div>
            </div>
            {f.pagamentoI==='Boleto'&&<div style={{marginTop:8,fontSize:11,color:'#b45309',background:'#fff',borderRadius:5,padding:'6px 10px',border:'1px solid #fde68a'}}>📄 Financeiro gera o boleto</div>}
            {(f.pagamentoI==='Pix'||f.pagamentoI==='Cartão')&&<div style={{marginTop:8,fontSize:11,color:'#27ae60',background:'#f0fff4',borderRadius:5,padding:'6px 10px',border:'1px solid #9ae6b4'}}>⚡ Você gera o link ao salvar</div>}
          </div>
        )}

        {/* Equipamento */}
        {parseValor(f.vE)>0&&(
          <div style={{background:'#f0fff4',borderRadius:8,padding:'12px',marginBottom:10,border:'1px solid #9ae6b4'}}>
            <div style={{fontWeight:700,fontSize:11,color:'#276749',marginBottom:8}}>💻 Equipamento — {moeda(parseValor(f.vE))}</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
              <div><label style={lbl}>Forma</label>
                <select style={fi} value={f.pagamentoE} onChange={e=>{up('pagamentoE',e.target.value);if(e.target.value==='Pix')up('parcelasE',1);}}>
                  {FORMAS_ASAAS.map(x=><option key={x}>{x}</option>)}
                </select>
              </div>
              <div><label style={lbl}>Parcelas</label>
                <select style={fi} value={f.parcelasE} onChange={e=>up('parcelasE',+e.target.value)} disabled={f.pagamentoE==='Pix'}>
                  {[1,2,3,4,5,6,7,8,9,10].map(n=><option key={n} value={n}>{n}x</option>)}
                </select>
              </div>
            </div>
            {f.pagamentoE==='Boleto'&&<div style={{marginTop:8,fontSize:11,color:'#276749',background:'#fff',borderRadius:5,padding:'6px 10px',border:'1px solid #9ae6b4'}}>📄 Financeiro gera o boleto</div>}
            {(f.pagamentoE==='Pix'||f.pagamentoE==='Cartão')&&<div style={{marginTop:8,fontSize:11,color:'#27ae60',background:'#f0fff4',borderRadius:5,padding:'6px 10px',border:'1px solid #9ae6b4'}}>⚡ Você gera o link ao salvar</div>}
          </div>
        )}

        {/* Sistema */}
        {parseValor(f.vS)>0&&(
          <div style={{background:'#ebf8ff',borderRadius:8,padding:'12px',border:'1px solid #bee3f8'}}>
            <div style={{fontWeight:700,fontSize:11,color:'#2b6cb0',marginBottom:8}}>🔄 Sistema — {moeda(parseValor(f.vS))}/mês</div>
            <div><label style={lbl}>Data 1º vencimento *</label><input style={fi} type="date" value={f.dtBoleto} onChange={e=>up('dtBoleto',e.target.value)}/></div>
            <div style={{marginTop:8,fontSize:11,color:'#2b6cb0',background:'#fff',borderRadius:5,padding:'6px 10px',border:'1px solid #bee3f8'}}>📄 Boleto recorrente mensal — Financeiro processa</div>
          </div>
        )}
      </div>

      {/* Contrato */}
      <div style={sec}>
        <div style={{fontWeight:700,fontSize:12,color:'#27ae60',marginBottom:12,textTransform:'uppercase'}}>Contrato</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
          <div>
            <label style={{...lbl,color:erros.vendedor?'#e74c3c':'#7f8c8d'}}>{erros.vendedor?'Vendedor — '+erros.vendedor:'Vendedor *'}</label>
            <select style={fiErr('vendedor')} value={f.vendedor} onChange={e=>up('vendedor',e.target.value)}>
              <option value="">— Selecione —</option>
              {listaVendedores.map(v=><option key={v}>{v}</option>)}
            </select>
          </div>
          <div><label style={{...lbl,color:erros.plano?'#e74c3c':'#7f8c8d'}}>{erros.plano?'Plano — '+erros.plano:'Plano *'}</label>
            <select style={fiErr('plano')} value={f.plano} onChange={e=>up('plano',e.target.value)}>{PLANOS.map(p=><option key={p}>{p}</option>)}</select>
          </div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
          <div><label style={lbl}>Status</label>
            <select style={fi} value={f.status} onChange={e=>up('status',e.target.value)}>
              {STATUS_CLIENTE.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>
          <div><label style={lbl}>Emitir NF-e</label><select style={fi} value={f.nfe} onChange={e=>up('nfe',e.target.value)}><option>Sim</option><option>Não</option></select></div>
        </div>
        <div><label style={lbl}>Observações</label><textarea style={{...fi,resize:'vertical',minHeight:56,textTransform:'uppercase'}} value={f.obs} onChange={e=>up('obs',e.target.value.toUpperCase())}/></div>
      </div>

      {/* Despacho do equipamento */}
      {requerPag&&(
        <div style={{...sec,borderLeft:`4px solid ${C.orange}`}}>
          <div style={{fontWeight:700,fontSize:12,color:C.orange,marginBottom:12,textTransform:'uppercase'}}>📦 Equipamento</div>
          <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:f.despachado==='Sim'?12:0}}>
            <label style={lbl}>Despachado?</label>
            <div style={{display:'flex',gap:6}}>
              {['Não','Sim'].map(v=>(
                <button key={v} onClick={()=>up('despachado',v)} style={{padding:'6px 18px',borderRadius:6,border:`2px solid ${f.despachado===v?(v==='Sim'?C.green:C.red):'#dde1e7'}`,background:f.despachado===v?(v==='Sim'?'#f0fff4':'#fff5f5'):'#fff',color:f.despachado===v?(v==='Sim'?C.green:C.red):C.textMuted,fontWeight:700,cursor:'pointer',fontSize:12}}>
                  {v==='Sim'?'✅ Sim':'❌ Não'}
                </button>
              ))}
            </div>
          </div>
          {f.despachado==='Sim'&&(
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
              <div><label style={lbl}>Nº rastreio (Sedex)</label><input style={{...fi,textTransform:'uppercase'}} value={f.equipRastreio} onChange={e=>up('equipRastreio',e.target.value.toUpperCase())} placeholder="XX000000000BR"/></div>
              <div><label style={lbl}>Data de envio</label><input style={fi} type="date" value={f.equipDataEnvio} onChange={e=>up('equipDataEnvio',e.target.value)}/></div>
            </div>
          )}
        </div>
      )}

      <button onClick={salvar} style={{width:'100%',padding:'12px',borderRadius:6,border:'none',background:'#3498db',color:'#fff',fontWeight:700,cursor:'pointer',fontSize:14,display:'flex',alignItems:'center',justifyContent:'center',gap:8}}>
        <i className="ti ti-device-floppy"/> Salvar cliente
      </button>
    </div>
  );
}
// --- DETALHE CLIENTE ----------------------------------------------------------
// --- CAMPO HELPER (fora de DetalheCliente para evitar perda de foco) ----------
function CampoDetalhe({label,field,type,opts,span,f,up,editMode,fi,fiView,lbl}){
  type=type||'text';
  const upperTypes=['text'];
  const shouldUpper=upperTypes.includes(type)&&!opts&&field!=='email'&&field!=='equipRastreio';
  const viewVal=()=>{
    if(!f[field]&&f[field]!==0)return'—';
    if(type==='date'){try{return new Date(f[field]+'T12:00:00').toLocaleDateString('pt-BR');}catch(e){return f[field];}}
    return f[field];
  };
  return(
    <div style={span?{gridColumn:`span ${span}`}:{}}>
      <label style={lbl}>{label}</label>
      {editMode
        ? opts
          ? <select style={fi} value={f[field]||''} onChange={e=>up(field,e.target.value)}>
              {opts.map(o=>typeof o==='object'
                ?<option key={o.v} value={o.v}>{o.l}</option>
                :<option key={o}>{o}</option>)}
            </select>
          : type==='textarea'
            ? <textarea style={{...fi,resize:'vertical',minHeight:60,textTransform:'uppercase'}} value={f[field]||''} onChange={e=>up(field,e.target.value.toUpperCase())}/>
            : field==='tel'
              ? <input style={{...fi}} type="tel" value={f[field]||''} onChange={e=>up(field,mascaraTel(e.target.value))} placeholder="(00) 00000-0000" maxLength={15}/>
              : <input style={{...fi,textTransform:shouldUpper?'uppercase':'none'}} type={type} step={type==='number'?'0.01':undefined} value={f[field]||''} onChange={e=>up(field,shouldUpper?e.target.value.toUpperCase():e.target.value)}/>
        : <div style={fiView}>{viewVal()}</div>
      }
    </div>
  );
}

function DetalheCliente({c,onVoltar,onUpdate,vendedoresCad,equipamentosCad,perfil}){
  const [editMode,setEditMode]=useState(false);
  const [saved,setSaved]=useState(false);
  const [modalFaturamento,setModalFaturamento]=useState(false);
  const [modalAlteracao,setModalAlteracao]=useState(null); // null | 'valor' | 'cancelamento'
  const [f,setF]=useState({
    nome:c.nome||'',
    empresa:c.empresa||'',
    cnpj:c.cnpj||'',
    contato:c.contato||'',
    tel:mascaraTel(c.tel||''),
    fone:c.fone||'',
    email:c.email||'',
    cep:c.cep||'',
    rua:c.rua||'',
    numero:c.numero||'',
    complemento:c.complemento||'',
    bairro:c.bairro||'',
    cidade:c.cidade||'',
    inscMunicipal:c.inscMunicipal||'',
    inscEstadual:c.inscEstadual||'',
    func:c.func!=null?String(c.func):'',
    equipTipo:c.equipTipo||'Evo40',
    vI:c.vI!=null?String(c.vI):'0',
    vE:c.vE!=null?String(c.vE):'0',
    vS:c.vS!=null?String(c.vS):'0',
    pagamento:c.pagamento||'Boleto',
    pagamentoI:c.pagamentoI||'Boleto',
    pagamentoE:c.pagamentoE||'Boleto',
    parcelasI:c.parcelasI||1,
    parcelasE:c.parcelasE||1,
    dtBoleto:c.dtBoleto||'',
    plano:c.plano==='—'?'Basic':c.plano||'Basic',
    vendedor:c.vendedor==='—'?'':c.vendedor||'',
    status:c.status||'Faturado',
    nfe:c.nfe||'Não',
    obs:c.obs||'',
    renovacao:c.renovacao||'',
    equipPago:c.equipPago||'Não se aplica',
    equipRastreio:c.equipRastreio||'',
    equipDataEnvio:c.equipDataEnvio||'',
    despachado:c.despachado||'Não',
    asaas_id:c.asaas_id||'',
    asaas_status:c.asaas_status||'',
    asaas_link_impl:c.asaas_link_impl||'',
    asaas_link_equip:c.asaas_link_equip||'',
    asaas_status_impl:c.asaas_status_impl||'',
    asaas_status_equip:c.asaas_status_equip||'',
    asaas_status_sistema:c.asaas_status_sistema||'',
    asaas_ultimo_pagamento:c.asaas_ultimo_pagamento||'',
  });
  const up=(k,v)=>setF(x=>({...x,[k]:v}));
  const fi={padding:'7px 10px',borderRadius:5,border:'1px solid #dde1e7',fontSize:13,color:'#2c3e50',background:'#fff',width:'100%',boxSizing:'border-box'};
  const fiView={padding:'7px 10px',borderRadius:5,border:'1px solid #ecf0f1',fontSize:13,color:'#555',background:'#f8f9fa',width:'100%',boxSizing:'border-box',minHeight:34};
  const lbl={fontSize:11,color:'#7f8c8d',display:'block',marginBottom:3,fontWeight:700,textTransform:'uppercase',letterSpacing:.4};
  const sec={background:C.card,borderRadius:8,padding:'16px',marginBottom:12,boxShadow:'0 1px 3px rgba(0,0,0,.06)'};
  const totEdit=(parseValor(f.vI)||0)+(parseValor(f.vE)||0)+(parseValor(f.vS)||0);

  async function salvar(){
    if(!f.nome.trim()){alert('Nome obrigatório');return;}
    const vI=parseValor(f.vI),vE=parseValor(f.vE),vS=parseValor(f.vS);
    const upd={...c,...f,
      vI,vE,vS,
      total:vI+vE+vS,
      func:parseInt(f.func)||0,
      vendedor:f.vendedor||'—',
      equipPago:f.equipPago,
      equipRastreio:f.equipRastreio.trim(),
      equipDataEnvio:f.equipDataEnvio,
    };
    await onUpdate(upd);
    setSaved(true);setEditMode(false);
    setTimeout(()=>setSaved(false),2500);
  }

  // Helper: renderiza campo como input/select (edit) ou div (view)
  // Campo é definido fora deste componente para evitar recriação a cada render

  return(
    <div style={{fontFamily:'sans-serif'}}>
      {/* Cabeçalho */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16,flexWrap:'wrap',gap:8}}>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <button onClick={onVoltar} style={{background:'none',border:'none',cursor:'pointer',color:C.blue,fontSize:13,display:'flex',alignItems:'center',gap:4,padding:0}}>
            <i className="ti ti-arrow-left"/> Voltar
          </button>
          <span style={{fontWeight:700,fontSize:15,color:C.text,maxWidth:300,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{f.nome||c.nome}</span>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          {saved&&<span style={{fontSize:12,color:C.green,display:'flex',alignItems:'center',gap:4}}><i className="ti ti-check"/> Salvo!</span>}
          {editMode
            ? <>
                <button onClick={()=>setEditMode(false)} style={{padding:'7px 14px',borderRadius:5,border:'1px solid #dde1e7',background:'#fff',cursor:'pointer',fontSize:12,color:C.textMuted}}>
                  Cancelar
                </button>
                <button onClick={salvar} style={{padding:'7px 16px',borderRadius:5,border:'none',background:C.green,color:'#fff',cursor:'pointer',fontWeight:700,fontSize:12,display:'flex',alignItems:'center',gap:6}}>
                  <i className="ti ti-device-floppy"/> Salvar alterações
                </button>
              </>
            : <button onClick={()=>setEditMode(true)} style={{padding:'7px 16px',borderRadius:5,border:'none',background:C.blue,color:'#fff',cursor:'pointer',fontWeight:700,fontSize:12,display:'flex',alignItems:'center',gap:6}}>
                <i className="ti ti-edit"/> Editar cliente
              </button>
          }
        </div>
      </div>

      {/* Resumo de valores (sempre visível) */}
      <div style={{...sec,borderTop:`3px solid ${C.blue}`}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12,flexWrap:'wrap',gap:8}}>
          <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
            <span style={{background:'#ebf5fb',color:C.blue,padding:'2px 10px',borderRadius:20,fontSize:11,fontWeight:700}}>{f.plano}</span>
            <span style={{background:corStatus(f.status)+'22',color:corStatus(f.status),padding:'2px 10px',borderRadius:20,fontSize:11,fontWeight:700}}>
              {labelStatus(f.status)}
            </span>
          </div>
          <div style={{fontWeight:700,fontSize:22,color:C.blue}}>{moeda(editMode?totEdit:c.total)}</div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
          {[['Sistema/mês','vS','#8b5cf6'],['Implantação','vI','#f97316'],['Equipamento','vE','#06b6d4']].map(([l,k,cor])=>(
            <div key={k} style={{background:'#f8f9fa',borderRadius:6,padding:'10px',textAlign:'center',borderTop:`3px solid ${cor}`}}>
              <div style={{fontSize:10,color:'#7f8c8d',fontWeight:700,textTransform:'uppercase',marginBottom:4}}>{l}</div>
              {editMode
                ? <input style={{...fi,textAlign:'center',fontSize:14,fontWeight:700,padding:'4px 6px'}} type="number" step="0.01" value={f[k]} onChange={e=>up(k,e.target.value)}/>
                : <div style={{fontSize:15,fontWeight:700,color:'#2c3e50'}}>{moeda(parseValor(String(c[k]||0)))}</div>
              }
            </div>
          ))}
        </div>
      </div>

      {/* Dados da empresa */}
      <div style={sec}>
        <div style={{fontWeight:700,fontSize:12,color:C.blue,marginBottom:12,textTransform:'uppercase'}}>Dados do cliente</div>
        <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:10,marginBottom:10}}>
          <CampoDetalhe f={f} up={up} editMode={editMode} fi={fi} fiView={fiView} lbl={lbl} label="Nome *" field="nome"/>
          <CampoDetalhe f={f} up={up} editMode={editMode} fi={fi} fiView={fiView} lbl={lbl} label="CNPJ/CPF" field="cnpj"/>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
          <CampoDetalhe f={f} up={up} editMode={editMode} fi={fi} fiView={fiView} lbl={lbl} label="Empresa / Razão Social" field="empresa"/>
          <CampoDetalhe f={f} up={up} editMode={editMode} fi={fi} fiView={fiView} lbl={lbl} label="Email financeiro" field="email" type="email"/>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10,marginBottom:10}}>
          <CampoDetalhe f={f} up={up} editMode={editMode} fi={fi} fiView={fiView} lbl={lbl} label="Contato" field="contato"/>
          <CampoDetalhe f={f} up={up} editMode={editMode} fi={fi} fiView={fiView} lbl={lbl} label="Celular" field="tel"/>
          <CampoDetalhe f={f} up={up} editMode={editMode} fi={fi} fiView={fiView} lbl={lbl} label="Fone fixo" field="fone"/>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
          <CampoDetalhe f={f} up={up} editMode={editMode} fi={fi} fiView={fiView} lbl={lbl} label="Funcionários" field="func" type="number"/>
          <CampoDetalhe f={f} up={up} editMode={editMode} fi={fi} fiView={fiView} lbl={lbl} label="Equipamento" field="equipTipo" opts={equipamentosCad.length>0?equipamentosCad.map(e=>e.nome):EQUIPS}/>
        </div>
        {/* Endereço */}
        <div style={{borderTop:'1px solid #e8eaed',paddingTop:10,marginTop:4}}>
          <div style={{fontSize:11,fontWeight:700,color:'#7f8c8d',marginBottom:8,textTransform:'uppercase'}}>Endereço</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 2fr 1fr',gap:10,marginBottom:10}}>
            <CampoDetalhe f={f} up={up} editMode={editMode} fi={fi} fiView={fiView} lbl={lbl} label="CEP" field="cep"/>
            <CampoDetalhe f={f} up={up} editMode={editMode} fi={fi} fiView={fiView} lbl={lbl} label="Rua" field="rua"/>
            <CampoDetalhe f={f} up={up} editMode={editMode} fi={fi} fiView={fiView} lbl={lbl} label="Número" field="numero"/>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10,marginBottom:10}}>
            <CampoDetalhe f={f} up={up} editMode={editMode} fi={fi} fiView={fiView} lbl={lbl} label="Complemento" field="complemento"/>
            <CampoDetalhe f={f} up={up} editMode={editMode} fi={fi} fiView={fiView} lbl={lbl} label="Bairro" field="bairro"/>
            <CampoDetalhe f={f} up={up} editMode={editMode} fi={fi} fiView={fiView} lbl={lbl} label="Cidade" field="cidade"/>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
            <CampoDetalhe f={f} up={up} editMode={editMode} fi={fi} fiView={fiView} lbl={lbl} label="Inscrição Municipal" field="inscMunicipal"/>
            <CampoDetalhe f={f} up={up} editMode={editMode} fi={fi} fiView={fiView} lbl={lbl} label="Inscrição Estadual" field="inscEstadual"/>
          </div>
        </div>
      </div>

      {/* Contrato */}
      <div style={sec}>
        <div style={{fontWeight:700,fontSize:12,color:C.green,marginBottom:12,textTransform:'uppercase'}}>Contrato</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:10,marginBottom:10}}>
          <CampoDetalhe f={f} up={up} editMode={editMode} fi={fi} fiView={fiView} lbl={lbl} label="Plano" field="plano" opts={PLANOS}/>
          <CampoDetalhe f={f} up={up} editMode={editMode} fi={fi} fiView={fiView} lbl={lbl} label="Vendedor" field="vendedor" opts={vendedoresCad.length>0?['—',...vendedoresCad.map(v=>v.nome)]:null}/>
          <CampoDetalhe f={f} up={up} editMode={editMode} fi={fi} fiView={fiView} lbl={lbl} label="Status" field="status" opts={STATUS_CLIENTE.map(s=>({v:s.id,l:s.label}))}/>
          <CampoDetalhe f={f} up={up} editMode={editMode} fi={fi} fiView={fiView} lbl={lbl} label="Emitir NF-e" field="nfe" opts={['Sim','Não']}/>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
          <CampoDetalhe f={f} up={up} editMode={editMode} fi={fi} fiView={fiView} lbl={lbl} label="Forma de pagamento" field="pagamento" opts={FORMAS}/>
          <CampoDetalhe f={f} up={up} editMode={editMode} fi={fi} fiView={fiView} lbl={lbl} label="Data 1º boleto" field="dtBoleto" type="date"/>
        </div>
        <CampoDetalhe f={f} up={up} editMode={editMode} fi={fi} fiView={fiView} lbl={lbl} label="Observações" field="obs" type="textarea" span={2}/>
      </div>

      {/* Despacho do equipamento */}
      {(()=>{
        const equipSel=(equipamentosCad||[]).find(e=>e.nome===f.equipTipo);
        const requerPag=equipSel?equipSel.requerPagamento:(f.despachado&&f.despachado!=='Não');
        if(!requerPag&&!f.despachado)return null;
        return(
          <div style={{...sec,borderLeft:`4px solid ${C.orange}`}}>
            <div style={{fontWeight:700,fontSize:12,color:C.orange,marginBottom:12,textTransform:'uppercase'}}>📦 Equipamento — Despacho</div>
            <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:(f.despachado==='Sim')?12:0}}>
              <label style={{fontSize:11,color:'#7f8c8d',fontWeight:700,textTransform:'uppercase'}}>Despachado?</label>
              {editMode?(
                <div style={{display:'flex',gap:6}}>
                  {['Não','Sim'].map(v=>(
                    <button key={v} onClick={()=>up('despachado',v)} style={{padding:'6px 18px',borderRadius:6,border:`2px solid ${f.despachado===v?(v==='Sim'?C.green:C.red):'#dde1e7'}`,background:f.despachado===v?(v==='Sim'?'#f0fff4':'#fff5f5'):'#fff',color:f.despachado===v?(v==='Sim'?C.green:C.red):C.textMuted,fontWeight:700,cursor:'pointer',fontSize:12}}>
                      {v==='Sim'?'✅ Sim':'❌ Não'}
                    </button>
                  ))}
                </div>
              ):(
                <span style={{fontWeight:700,color:f.despachado==='Sim'?C.green:C.red,fontSize:13}}>
                  {f.despachado==='Sim'?'✅ Despachado':'❌ Não despachado'}
                </span>
              )}
            </div>
            {(f.despachado==='Sim')&&(
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10}}>
                <div>
                  <label style={{fontSize:11,color:'#7f8c8d',display:'block',marginBottom:3,fontWeight:700,textTransform:'uppercase'}}>Nº rastreio (Sedex)</label>
                  {editMode
                    ?<input style={{...fi,textTransform:'uppercase'}} value={f.equipRastreio} onChange={e=>up('equipRastreio',e.target.value.toUpperCase())} placeholder="XX000000000BR"/>
                    :<div style={{display:'flex',alignItems:'center',gap:6}}>
                      <div style={{...fiView,fontFamily:'monospace',letterSpacing:1,flex:1}}>{f.equipRastreio||'—'}</div>
                      {f.equipRastreio&&<>
                        <button title="Copiar código" onClick={()=>{navigator.clipboard.writeText(f.equipRastreio);}} style={{padding:'5px 10px',borderRadius:5,border:'1px solid #dde1e7',background:'#fff',cursor:'pointer',color:C.blue,fontSize:11,fontWeight:700,flexShrink:0}}>📋</button>
                        <a href={`https://rastreamento.correios.com.br/app/index.php?objetos=${f.equipRastreio}`} target="_blank" rel="noopener noreferrer" style={{padding:'5px 10px',borderRadius:5,border:'1px solid #dde1e7',background:'#fff',color:C.teal,fontSize:11,fontWeight:700,flexShrink:0,textDecoration:'none'}}>📦 Correios</a>
                        <a href={`mailto:${f.email}?subject=${encodeURIComponent('Seu equipamento foi despachado! 📦')}&body=${encodeURIComponent('Olá!\n\nSeu equipamento foi despachado!\n\nRastreio: '+f.equipRastreio+'\nhttps://rastreamento.correios.com.br/app/index.php?objetos='+f.equipRastreio)}`} style={{padding:'5px 10px',borderRadius:5,border:'1px solid #dde1e7',background:'#fff',color:C.orange,fontSize:11,fontWeight:700,flexShrink:0,textDecoration:'none',opacity:f.email?1:0.4}}>✉️</a>
                        {(()=>{const waNum=telParaWa(f.tel||'');const waNome=(f.contato||f.nome||'').split(' ')[0];const waMsg=encodeURIComponent('Olá, '+waNome+'! 😊\n\nSeu equipamento foi despachado!\n\n📦 *Rastreio:* '+f.equipRastreio+'\n🔍 https://rastreamento.correios.com.br/app/index.php?objetos='+f.equipRastreio+'\n\n_Guion Informática_');return <a href={waNum?`https://wa.me/${waNum}?text=${waMsg}`:'#'} target="_blank" rel="noopener noreferrer" style={{padding:'5px 10px',borderRadius:5,border:'1px solid #25D366',background:'#fff',color:'#25D366',fontSize:11,fontWeight:700,flexShrink:0,textDecoration:'none',opacity:waNum?1:0.4}}>📲 WA</a>;})()}
                      </>}
                    </div>
                  }
                </div>
                <div>
                  <label style={{fontSize:11,color:'#7f8c8d',display:'block',marginBottom:3,fontWeight:700,textTransform:'uppercase'}}>Data de envio</label>
                  {editMode
                    ?<input style={fi} type="date" value={f.equipDataEnvio} onChange={e=>up('equipDataEnvio',e.target.value)}/>
                    :<div style={fiView}>{f.equipDataEnvio?new Date(f.equipDataEnvio+'T12:00:00').toLocaleDateString('pt-BR'):'—'}</div>
                  }
                </div>
              </div>
            )}
          </div>
        );
      })()}
      {/* PAINEL ASAAS */}
      <div style={sec}>
        <div style={{fontWeight:700,fontSize:12,color:'#27ae60',marginBottom:12,textTransform:'uppercase',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <span>💰 Financeiro Asaas</span>
          {c.asaas_id&&<span style={{fontSize:10,color:'#7f8c8d',fontWeight:400}}>ID: {c.asaas_id}</span>}
        </div>
        <PainelAsaasCliente cliente={f} perfil={perfil} onUpdate={async u=>{await onUpdate(u);setF(u);}}/>

        {/* Botão Gerar Faturamento — só financeiro/admin e sem asaas_id ainda */}
        {(perfil==='financeiro'||perfil==='admin')&&!c.asaas_id&&(
          <button onClick={()=>setModalFaturamento(true)} style={{width:'100%',marginTop:12,padding:'12px',borderRadius:7,border:'none',background:'#27ae60',color:'#fff',fontWeight:700,cursor:'pointer',fontSize:14,display:'flex',alignItems:'center',justifyContent:'center',gap:8}}>
            🚀 Gerar Faturamento no Asaas
          </button>
        )}

        {/* Ações edição/cancelamento — só financeiro/admin e com asaas_id */}
        {(perfil==='financeiro'||perfil==='admin')&&c.asaas_id&&c.asaas_status!=='CANCELED'&&(
          <div style={{display:'flex',gap:8,marginTop:12,flexWrap:'wrap'}}>
            <button onClick={()=>setModalAlteracao('valor')} style={{flex:1,padding:'8px',borderRadius:6,border:'1px solid #f5a623',background:'#fff',color:'#f5a623',fontWeight:700,cursor:'pointer',fontSize:12}}>
              ✏️ Alterar valor/vencimento
            </button>
            <button onClick={()=>setModalAlteracao('cancelamento')} style={{flex:1,padding:'8px',borderRadius:6,border:'1px solid #e74c3c',background:'#fff',color:'#e74c3c',fontWeight:700,cursor:'pointer',fontSize:12}}>
              ❌ Cancelar assinatura
            </button>
          </div>
        )}
      </div>

      {/* Modais */}
      {modalFaturamento&&(
        <ModalGerarFaturamento
          cliente={f}
          onConfirmar={async(checks)=>{
            try{
              // 1. Criar/buscar cliente no Asaas
              const asaasCliente=await asaasCriarOuBuscarCliente(f);
              const asaasId=asaasCliente.id;
              const hoje=new Date();
              const dueDatePadrao=`${hoje.getFullYear()}-${String(hoje.getMonth()+1).padStart(2,'0')}-${String(hoje.getDate()+3).padStart(2,'0')}`;

              // 2. Cobrança implantação boleto
              if(checks.impl&&f.vI>0){
                await asaasCriarCobranca(asaasId,f.vI,f.parcelasI||1,'BOLETO',dueDatePadrao,'Implantação Secullum');
              }
              // 3. Cobrança equipamento boleto
              if(checks.equip&&f.vE>0){
                await asaasCriarCobranca(asaasId,f.vE,f.parcelasE||1,'BOLETO',dueDatePadrao,'Equipamento Secullum');
              }
              // 4. Assinatura mensal sistema
              if(checks.sistema&&f.vS>0){
                await asaasCriarAssinatura(asaasId,f.vS,f.dtBoleto);
              }
              // 5. Salvar asaas_id e atualizar status
              await onUpdate({...c,asaas_id:asaasId,asaas_status:'PENDING',status:'Faturado'});
              // 6. Histórico
              await setDoc(doc(collection(db,'historico_cliente')),{
                clienteId:c.id,clienteNome:c.nome,tipo:'faturamento_gerado',
                descricao:`Faturamento gerado no Asaas. ID: ${asaasId}. Impl: ${checks.impl}, Equip: ${checks.equip}, Sistema: ${checks.sistema}`,
                usuario:auth.currentUser?.email||'—',data:new Date().toISOString(),
              });
              setModalFaturamento(false);
              alert('✅ Faturamento gerado com sucesso no Asaas!');
            }catch(err){
              alert('❌ Erro ao gerar faturamento: '+err.message);
            }
          }}
          onCancelar={()=>setModalFaturamento(false)}
        />
      )}
      {modalAlteracao&&(
        <ModalConfirmacaoFinanceira
          tipo={modalAlteracao}
          cliente={c}
          onConfirmar={async({quem,motivo})=>{
            if(modalAlteracao==='cancelamento'){
              await onUpdate({...c,asaas_status:'CANCELED',status:'Cancelado'});
            }
            // Registra histórico
            await setDoc(doc(collection(db,'historico_cliente')),{
              clienteId:c.id,clienteNome:c.nome,
              tipo:modalAlteracao,
              descricao:modalAlteracao==='cancelamento'?'Assinatura cancelada no Asaas':'Dados financeiros alterados',
              solicitadoPor:quem,
              motivo,
              usuario:auth.currentUser?.email||'—',
              data:new Date().toISOString(),
            });
            setModalAlteracao(null);
          }}
          onCancelar={()=>setModalAlteracao(null)}
        />
      )}
    </div>
  );
}

// --- CONFIGURAÇÕES ------------------------------------------------------------
function ConfigView({usuarios,currentUser,vendedoresCad,equipamentosCad,menuOrder,onMenuOrderChange,orcServicos,orcFormas,orcTemplates}){
  const [novoVend,setNovoVend]=useState('');
  const [savedVend,setSavedVend]=useState(false);
  const [novoEquip,setNovoEquip]=useState({nome:'',requerPagamento:true});
  const [savedEquip,setSavedEquip]=useState(false);
  const [editEquipId,setEditEquipId]=useState(null);
  // Convite
  const [convite,setConvite]=useState({nome:'',email:'',perfil:'colaborador'});
  const [conviteStatus,setConviteStatus]=useState(''); // ''|'enviando'|'ok'|'erro'
  const [conviteErro,setConviteErro]=useState('');
  // Mapeamento vendedores
  const [mapa,setMapa]=useState({});
  const [mapaStatus,setMapaStatus]=useState('');
  // Ordenação do menu (drag)
  const [dragMenuId,setDragMenuId]=useState(null);
  const [dragOverId,setDragOverId]=useState(null);
  const [localOrder,setLocalOrder]=useState(()=>menuOrder||NAV_ITEMS_BASE.map(n=>n.id));

  const fi={padding:'7px 10px',borderRadius:5,border:'1px solid #dde1e7',fontSize:13,color:'#2c3e50',background:'#fff',width:'100%',boxSizing:'border-box'};
  const lbl={fontSize:11,color:'#7f8c8d',display:'block',marginBottom:3,fontWeight:700,textTransform:'uppercase',letterSpacing:.4};
  const sec={background:'#fff',borderRadius:8,padding:'16px',boxShadow:'0 1px 3px rgba(0,0,0,.08)',marginBottom:16};

  // Nomes antigos nos dados históricos que não correspondem a nenhum vendedor cadastrado
  const nomesAntigos=[...new Set(CLIENTES_BASE.map(c=>c.vendedor).filter(v=>v&&v!=='—'))].sort();
  const nomesCadastrados=vendedoresCad.map(v=>v.nome);
  const nomesParaMapear=nomesAntigos.filter(n=>!nomesCadastrados.some(c=>c.toLowerCase()===n.toLowerCase()));

  async function addVendedor(){
    if(!novoVend.trim())return;
    const id='vend_'+Date.now();
    await setDoc(doc(db,'vendedores',id),{nome:novoVend.trim().toUpperCase(),criadoEm:new Date().toISOString()});
    setNovoVend('');setSavedVend(true);setTimeout(()=>setSavedVend(false),2000);
  }
  async function removeVendedor(id){
    if(!window.confirm('Remover este vendedor?'))return;
    await deleteDoc(doc(db,'vendedores',id));
  }
  async function addEquipamento(){
    if(!novoEquip.nome.trim())return;
    const id='equip_'+Date.now();
    await setDoc(doc(db,'equipamentos',id),{nome:novoEquip.nome.trim().toUpperCase(),requerPagamento:novoEquip.requerPagamento,criadoEm:new Date().toISOString()});
    setNovoEquip({nome:'',requerPagamento:true});setSavedEquip(true);setTimeout(()=>setSavedEquip(false),2000);
  }
  async function removeEquipamento(id){
    if(!window.confirm('Remover este equipamento?'))return;
    await deleteDoc(doc(db,'equipamentos',id));
  }
  async function salvarEdicaoEquip(){
    if(!novoEquip.nome.trim())return;
    await setDoc(doc(db,'equipamentos',editEquipId),{nome:novoEquip.nome.trim().toUpperCase(),requerPagamento:novoEquip.requerPagamento},{merge:true});
    setNovoEquip({nome:'',requerPagamento:true});setEditEquipId(null);setSavedEquip(true);setTimeout(()=>setSavedEquip(false),2000);
  }
  function iniciarEdicaoEquip(e){
    setEditEquipId(e.id);
    setNovoEquip({nome:e.nome,requerPagamento:e.requerPagamento});
  }

  async function enviarConvite(){
    if(!convite.nome.trim()||!convite.email.trim()){setConviteErro('Preencha nome e email.');return;}
    setConviteStatus('enviando');setConviteErro('');
    try{
      // Salva o usuário no Firestore como pendente
      const tempId='convite_'+Date.now();
      await setDoc(doc(db,'usuarios',tempId),{
        nome:convite.nome.trim().toUpperCase(),
        email:convite.email.trim().toLowerCase(),
        perfil:convite.perfil,
        status:'pendente',
        convidadoPor:currentUser?.email||'',
        criadoEm:new Date().toISOString()
      });
      // Envia email de redefinição de senha (Firebase cria o link automaticamente)
      // Precisamos criar o usuário primeiro com senha temporária
      const senhaTmp='Secullum@'+Date.now();
      const cred=await createUserWithEmailAndPassword(auth,convite.email.trim().toLowerCase(),senhaTmp);
      // Atualiza o doc com o UID real
      await setDoc(doc(db,'usuarios',cred.user.uid),{
        nome:convite.nome.trim().toUpperCase(),
        email:convite.email.trim().toLowerCase(),
        perfil:convite.perfil,
        status:'pendente',
        convidadoPor:currentUser?.email||'',
        criadoEm:new Date().toISOString()
      });
      // Remove o doc temporário
      await deleteDoc(doc(db,'usuarios',tempId));
      // Envia email para redefinir senha
      await sendPasswordResetEmail(auth,convite.email.trim().toLowerCase());
      // Volta a logar como o usuário admin atual
      setConviteStatus('ok');
      setConvite({nome:'',email:'',perfil:'colaborador'});
      setTimeout(()=>setConviteStatus(''),3000);
    }catch(e){
      setConviteStatus('erro');
      setConviteErro(e.code==='auth/email-already-in-use'?'Este email já está cadastrado.':'Erro: '+e.message);
    }
  }

  async function salvarMapeamento(){
    if(!Object.keys(mapa).length)return;
    setMapaStatus('salvando');
    try{
      // Atualiza overrides dos clientes base
      const lotes=Object.entries(mapa).filter(([,v])=>v);
      for(const [nomeAntigo,nomeNovo] of lotes){
        const clientes=CLIENTES_BASE.filter(c=>c.vendedor===nomeAntigo);
        for(const c of clientes){
          const atual={};
          try{const snap=await getDocs(collection(db,'overrides'));snap.forEach(d=>{if(d.id===c.id)Object.assign(atual,d.data());});}catch(e){}
          await setDoc(doc(db,'overrides',c.id),{...atual,vendedor:nomeNovo},{merge:true});
        }
      }
      setMapa({});setMapaStatus('ok');
      setTimeout(()=>setMapaStatus(''),2500);
    }catch(e){setMapaStatus('erro');}
  }

  function salvarOrdemMenu(){
    onMenuOrderChange(localOrder);
    // Salva no Firestore vinculado ao usuário logado
    try{
      const uid=auth.currentUser?.uid;
      if(uid){
        setDoc(doc(db,'usuarios',uid),{menuOrder:localOrder},{merge:true});
      }
    }catch(e){}
  }

  function onDragStart(id){setDragMenuId(id);}
  function onDragOver(e,id){e.preventDefault();setDragOverId(id);}
  function onDrop(id){
    if(!dragMenuId||dragMenuId===id)return;
    const arr=[...localOrder];
    const from=arr.indexOf(dragMenuId),to=arr.indexOf(id);
    if(from<0||to<0)return;
    arr.splice(from,1);arr.splice(to,0,dragMenuId);
    setLocalOrder(arr);setDragMenuId(null);setDragOverId(null);
  }

  return(
    <div style={{fontFamily:'sans-serif'}}>

      {/* Sessão atual */}
      <div style={sec}>
        <div style={{fontWeight:700,fontSize:12,color:C.blue,marginBottom:12,textTransform:'uppercase'}}>Sessão atual</div>
        <div style={{display:'flex',gap:12,alignItems:'center'}}>
          <div style={{width:44,height:44,borderRadius:'50%',background:C.blue,display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontWeight:700,fontSize:16}}>{(currentUser?.email||'A')[0].toUpperCase()}</div>
          <div>
            <div style={{fontWeight:700,fontSize:14,color:'#2c3e50'}}>{currentUser?.nome||currentUser?.email}</div>
            <div style={{fontSize:12,color:'#7f8c8d'}}>{currentUser?.email}</div>
            <span style={{background:PERFIS[currentUser?.perfil||'admin']?.color||'#e74c3c',color:'#fff',padding:'2px 8px',borderRadius:10,fontSize:10,fontWeight:700}}>{PERFIS[currentUser?.perfil||'admin']?.label}</span>
          </div>
        </div>
      </div>

      {/* Convidar usuário */}
      <div style={{...sec,borderTop:`3px solid ${C.green}`}}>
        <div style={{fontWeight:700,fontSize:12,color:C.green,marginBottom:4,textTransform:'uppercase'}}>Convidar usuário</div>
        <div style={{fontSize:11,color:C.textMuted,marginBottom:12}}>O usuário receberá um email para definir a própria senha. Sua sessão não será afetada.</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
          <div><label style={lbl}>Nome completo</label><input style={fi} value={convite.nome} onChange={e=>setConvite(x=>({...x,nome:e.target.value.toUpperCase()}))} placeholder="NOME DO USUÁRIO"/></div>
          <div><label style={lbl}>Email</label><input style={fi} type="email" value={convite.email} onChange={e=>setConvite(x=>({...x,email:e.target.value}))}/></div>
        </div>
        <div style={{marginBottom:10}}>
          <label style={lbl}>Nível de acesso</label>
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
            {Object.entries(PERFIS).map(([k,p])=>(
              <div key={k} onClick={()=>setConvite(x=>({...x,perfil:k}))} style={{borderRadius:7,padding:'10px 12px',border:`2px solid ${convite.perfil===k?p.color:'#dde1e7'}`,background:convite.perfil===k?p.color+'11':'#fff',cursor:'pointer',transition:'all .15s'}}>
                <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:4}}>
                  <div style={{width:26,height:26,borderRadius:6,background:convite.perfil===k?p.color:'#ecf0f1',display:'flex',alignItems:'center',justifyContent:'center'}}>
                    <i className={`ti ${p.icon}`} style={{color:convite.perfil===k?'#fff':'#7f8c8d',fontSize:13}}/>
                  </div>
                  <span style={{fontWeight:700,fontSize:11,color:convite.perfil===k?p.color:'#2c3e50'}}>{p.label}</span>
                </div>
                <div style={{fontSize:10,color:'#7f8c8d'}}>{p.desc}</div>
              </div>
            ))}
          </div>
        </div>
        {conviteErro&&<div style={{background:'#fee2e2',color:'#991b1b',padding:'8px 12px',borderRadius:6,fontSize:12,marginBottom:10}}>{conviteErro}</div>}
        {conviteStatus==='ok'&&<div style={{background:'#d5f5e3',color:'#1e8449',padding:'8px 12px',borderRadius:6,fontSize:12,marginBottom:10}}>✓ Convite enviado! O usuário receberá um email para definir a senha.</div>}
        <button onClick={enviarConvite} disabled={conviteStatus==='enviando'} style={{width:'100%',padding:'10px',borderRadius:6,border:'none',background:conviteStatus==='ok'?C.green:C.blue,color:'#fff',fontWeight:700,cursor:'pointer',fontSize:13,display:'flex',alignItems:'center',justifyContent:'center',gap:8}}>
          <i className={`ti ${conviteStatus==='enviando'?'ti-loader':'ti-send'}`}/>{conviteStatus==='enviando'?'Enviando...':'Enviar convite'}
        </button>
      </div>

      {/* Usuários cadastrados */}
      <div style={sec}>
        <div style={{fontWeight:700,fontSize:12,color:'#2c3e50',marginBottom:12,textTransform:'uppercase'}}>Usuários ({usuarios.length})</div>
        {usuarios.map(u=>(
          <div key={u.id} style={{display:'flex',alignItems:'center',gap:12,padding:'10px 12px',borderRadius:6,background:'#f8f9fa',marginBottom:6}}>
            <div style={{width:36,height:36,borderRadius:'50%',background:PERFIS[u.perfil]?.color||C.blue,display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontWeight:700,fontSize:14,flexShrink:0}}>{(u.nome||u.email||'?')[0].toUpperCase()}</div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:700,fontSize:13,color:'#2c3e50'}}>{u.nome}</div>
              <div style={{fontSize:11,color:'#7f8c8d'}}>{u.email}</div>
            </div>
            <div style={{display:'flex',gap:6,alignItems:'center',flexShrink:0}}>
              {u.status==='pendente'&&<span style={{background:'#fef9e7',color:C.orange,padding:'2px 8px',borderRadius:10,fontSize:9,fontWeight:700}}>CONVITE PENDENTE</span>}
              <span style={{background:PERFIS[u.perfil]?.color||C.blue,color:'#fff',padding:'2px 8px',borderRadius:10,fontSize:10,fontWeight:700}}>{PERFIS[u.perfil]?.label||u.perfil}</span>
            </div>
          </div>
        ))}
        {usuarios.length===0&&<div style={{color:'#7f8c8d',fontSize:13,textAlign:'center',padding:'12px 0'}}>Nenhum usuário cadastrado.</div>}
      </div>

      {/* Mapeamento de vendedores antigos */}
      {nomesParaMapear.length>0&&(
        <div style={{...sec,borderTop:`3px solid ${C.orange}`}}>
          <div style={{fontWeight:700,fontSize:12,color:C.orange,marginBottom:4,textTransform:'uppercase'}}>Vincular vendedores antigos</div>
          <div style={{fontSize:11,color:C.textMuted,marginBottom:12}}>Esses nomes existem nos dados históricos mas não correspondem a nenhum vendedor cadastrado. Vincule cada um ao vendedor correto.</div>
          {nomesParaMapear.map(n=>(
            <div key={n} style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
              <div style={{width:120,fontSize:12,fontWeight:700,color:C.text,background:'#f8f9fa',padding:'6px 10px',borderRadius:5,flexShrink:0}}>{n}</div>
              <i className="ti ti-arrow-right" style={{color:C.textMuted,fontSize:14,flexShrink:0}}/>
              <select style={{...fi}} value={mapa[n]||''} onChange={e=>setMapa(x=>({...x,[n]:e.target.value}))}>
                <option value="">— Selecione o vendedor —</option>
                {vendedoresCad.map(v=><option key={v.id} value={v.nome}>{v.nome}</option>)}
              </select>
            </div>
          ))}
          {mapaStatus==='ok'&&<div style={{background:'#d5f5e3',color:'#1e8449',padding:'8px 12px',borderRadius:6,fontSize:12,marginBottom:10}}>✓ Clientes atualizados com sucesso!</div>}
          {mapaStatus==='erro'&&<div style={{background:'#fee2e2',color:'#991b1b',padding:'8px 12px',borderRadius:6,fontSize:12,marginBottom:10}}>Erro ao salvar. Tente novamente.</div>}
          <button onClick={salvarMapeamento} disabled={mapaStatus==='salvando'} style={{padding:'8px 18px',borderRadius:6,border:'none',background:C.orange,color:'#fff',fontWeight:700,cursor:'pointer',fontSize:12,display:'flex',alignItems:'center',gap:6}}>
            <i className="ti ti-device-floppy"/>{mapaStatus==='salvando'?'Salvando...':'Salvar mapeamento'}
          </button>
        </div>
      )}

      {/* Vendedores */}
      <div style={sec}>
        <div style={{fontWeight:700,fontSize:12,color:C.blue,marginBottom:12,textTransform:'uppercase'}}>Vendedores ({vendedoresCad.length})</div>
        <div style={{display:'flex',flexWrap:'wrap',gap:8,marginBottom:12}}>
          {vendedoresCad.map(v=>(
            <div key={v.id} style={{display:'flex',alignItems:'center',gap:6,background:'#ebf5fb',borderRadius:20,padding:'4px 12px'}}>
              <div style={{width:22,height:22,borderRadius:'50%',background:C.blue,display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontSize:10,fontWeight:700,flexShrink:0}}>{v.nome[0]}</div>
              <span style={{fontSize:12,fontWeight:600,color:C.text}}>{v.nome}</span>
              <button onClick={()=>removeVendedor(v.id)} style={{background:'none',border:'none',cursor:'pointer',color:'#e74c3c',fontSize:14,lineHeight:1,padding:'0 2px'}}>×</button>
            </div>
          ))}
          {vendedoresCad.length===0&&<span style={{fontSize:12,color:C.textMuted}}>Nenhum vendedor cadastrado.</span>}
        </div>
        <div style={{display:'flex',gap:8}}>
          <input style={{...fi,flex:1,textTransform:'uppercase'}} value={novoVend} onChange={e=>setNovoVend(e.target.value.toUpperCase())} onKeyDown={e=>e.key==='Enter'&&addVendedor()} placeholder="NOME DO VENDEDOR"/>
          <button onClick={addVendedor} style={{padding:'7px 16px',borderRadius:5,border:'none',background:savedVend?C.green:C.blue,color:'#fff',fontWeight:700,cursor:'pointer',fontSize:12,whiteSpace:'nowrap'}}>
            {savedVend?'✓ Adicionado!':'+ Adicionar'}
          </button>
        </div>
      </div>

      {/* Equipamentos */}
      <div style={sec}>
        <div style={{fontWeight:700,fontSize:12,color:C.teal,marginBottom:12,textTransform:'uppercase'}}>Equipamentos ({equipamentosCad.length})</div>
        <div style={{marginBottom:12}}>
          {equipamentosCad.map(e=>(
            <div key={e.id} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 12px',borderRadius:6,background:editEquipId===e.id?'#e8f4fd':'#f8f9fa',marginBottom:6,border:editEquipId===e.id?'1px solid #3498db':'1px solid transparent',transition:'all .15s'}}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={C.teal} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
              <span style={{flex:1,fontSize:12,fontWeight:600,color:C.text}}>{e.nome}</span>
              <span style={{fontSize:10,padding:'2px 8px',borderRadius:10,fontWeight:700,background:e.requerPagamento?'#fef9e7':'#d5f5e3',color:e.requerPagamento?C.orange:C.green}}>{e.requerPagamento?'Requer pagamento':'Sem custo'}</span>
              <button onClick={()=>iniciarEdicaoEquip(e)} title="Editar" style={{background:'none',border:'none',cursor:'pointer',color:'#3498db',fontSize:13,padding:'2px 5px'}}>✏️</button>
              <button onClick={()=>removeEquipamento(e.id)} title="Remover" style={{background:'none',border:'none',cursor:'pointer',color:'#e74c3c',fontSize:14,padding:'2px 5px'}}>×</button>
            </div>
          ))}
          {equipamentosCad.length===0&&<div style={{fontSize:12,color:C.textMuted,textAlign:'center',padding:'8px 0'}}>Nenhum equipamento cadastrado.</div>}
        </div>
        {/* Formulário add/edit */}
        <div style={{background:editEquipId?'#e8f4fd':'#f8f9fa',borderRadius:7,padding:'12px',border:editEquipId?'1px solid #3498db':'1px dashed #dde1e7',marginTop:4}}>
          <div style={{fontSize:11,fontWeight:700,color:editEquipId?'#3498db':C.textMuted,marginBottom:8,textTransform:'uppercase'}}>{editEquipId?'✏️ Editando equipamento':'+ Novo equipamento'}</div>
          <div style={{display:'flex',gap:8,alignItems:'flex-end'}}>
            <div style={{flex:1}}><label style={lbl}>Nome do equipamento</label><input style={{...fi,textTransform:'uppercase'}} value={novoEquip.nome} onChange={e=>setNovoEquip(x=>({...x,nome:e.target.value.toUpperCase()}))} onKeyDown={e=>e.key==='Enter'&&(editEquipId?salvarEdicaoEquip():addEquipamento())} placeholder="EX: EVO40, TABLET..."/></div>
            <div><label style={lbl}>Requer pagamento?</label>
              <select style={fi} value={String(novoEquip.requerPagamento)} onChange={e=>setNovoEquip(x=>({...x,requerPagamento:e.target.value==='true'}))}>
                <option value="true">Sim — cliente paga</option>
                <option value="false">Não — sem custo</option>
              </select>
            </div>
            {editEquipId?(
              <div style={{display:'flex',gap:6}}>
                <button onClick={salvarEdicaoEquip} style={{padding:'7px 14px',borderRadius:5,border:'none',background:savedEquip?C.green:'#3498db',color:'#fff',fontWeight:700,cursor:'pointer',fontSize:12,whiteSpace:'nowrap',height:36}}>
                  {savedEquip?'✓ Salvo!':'💾 Salvar'}
                </button>
                <button onClick={()=>{setEditEquipId(null);setNovoEquip({nome:'',requerPagamento:true});}} style={{padding:'7px 12px',borderRadius:5,border:'1px solid #dde1e7',background:'#fff',cursor:'pointer',fontSize:12,color:C.textMuted,height:36}}>
                  Cancelar
                </button>
              </div>
            ):(
              <button onClick={addEquipamento} style={{padding:'7px 16px',borderRadius:5,border:'none',background:savedEquip?C.green:C.teal,color:'#fff',fontWeight:700,cursor:'pointer',fontSize:12,whiteSpace:'nowrap',height:36}}>
                {savedEquip?'✓ Adicionado!':'+ Adicionar'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Orçamento — Serviços, Formas de pagamento e Templates */}
      <div style={{...sec,borderTop:`3px solid #f5a623`}}>
        <div style={{fontWeight:700,fontSize:12,color:'#f5a623',marginBottom:12,textTransform:'uppercase'}}>⚙️ Configurações de orçamento</div>
        <OrcConfigView orcServicos={orcServicos} orcFormas={orcFormas} orcTemplates={orcTemplates}/>
      </div>

      {/* Ordenação do menu */}
      <div style={sec}>
        <div style={{fontWeight:700,fontSize:12,color:C.purple,marginBottom:4,textTransform:'uppercase'}}>Ordem do menu</div>
        <div style={{fontSize:11,color:C.textMuted,marginBottom:12}}>Arraste os itens para reordenar. Clique em "+ Separador" para adicionar uma linha divisória.</div>
        <div style={{marginBottom:12}}>
          {localOrder.map((id,idx)=>{
            if(id.startsWith('sep_')){
              return(
                <div key={id} draggable onDragStart={()=>onDragStart(id)} onDragOver={e=>onDragOver(e,id)} onDrop={()=>onDrop(id)} onDragEnd={()=>{setDragMenuId(null);setDragOverId(null);}}
                  style={{display:'flex',alignItems:'center',gap:8,marginBottom:5,cursor:'grab',opacity:dragOverId===id?.5:1}}>
                  <i className="ti ti-grip-vertical" style={{color:C.textMuted,fontSize:14}}/>
                  <div style={{flex:1,height:1,background:'#dde1e7',borderRadius:1}}/>
                  <span style={{fontSize:10,color:C.textMuted,whiteSpace:'nowrap'}}>separador</span>
                  <button onClick={()=>setLocalOrder(o=>o.filter((_,i)=>i!==idx))} style={{background:'none',border:'none',cursor:'pointer',color:C.red,fontSize:13,padding:'0 2px'}}>×</button>
                </div>
              );
            }
            const item=NAV_ITEMS_BASE.find(n=>n.id===id);
            if(!item)return null;
            const iconColors={'dashboard':'#3498db','vendas':'#27ae60','financeiro':'#e67e22','clientes':'#9b59b6','novo':'#27ae60','implantacao':'#e74c3c','relatorios':'#1abc9c','solicitacoes':'#f39c12'};
            const cor=iconColors[id]||C.blue;
            return(
              <div key={id} draggable onDragStart={()=>onDragStart(id)} onDragOver={e=>onDragOver(e,id)} onDrop={()=>onDrop(id)} onDragEnd={()=>{setDragMenuId(null);setDragOverId(null);}}
                style={{display:'flex',alignItems:'center',gap:10,padding:'9px 12px',borderRadius:6,background:dragOverId===id?'#ebf5fb':'#f8f9fa',marginBottom:5,cursor:'grab',border:dragOverId===id?`1px dashed ${C.blue}`:'1px solid transparent',transition:'background .15s'}}>
                <i className="ti ti-grip-vertical" style={{color:C.textMuted,fontSize:16}}/>
                <div style={{width:28,height:28,borderRadius:6,background:cor,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                  <i className={`ti ${item.icon}`} style={{color:'#fff',fontSize:14}}/>
                </div>
                <span style={{fontSize:12,fontWeight:600,color:C.text,flex:1}}>{item.label}</span>
              </div>
            );
          })}
          {/* Config sempre fixo */}
          <div style={{display:'flex',alignItems:'center',gap:10,padding:'9px 12px',borderRadius:6,background:'#f8f9fa',marginBottom:5,opacity:.5,border:'1px solid #dde1e7'}}>
            <i className="ti ti-lock" style={{color:C.textMuted,fontSize:12}}/>
            <div style={{width:28,height:28,borderRadius:6,background:'#7f8c8d',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
              <i className="ti ti-settings" style={{color:'#fff',fontSize:14}}/>
            </div>
            <span style={{fontSize:12,fontWeight:600,color:C.textMuted,flex:1}}>Configurações — fixo</span>
          </div>
        </div>
        <div style={{display:'flex',gap:8}}>
          <button onClick={()=>setLocalOrder(o=>[...o,'sep_'+Date.now()])} style={{padding:'8px 14px',borderRadius:6,border:'1px dashed #dde1e7',background:'#fff',cursor:'pointer',fontSize:12,color:C.textMuted,display:'flex',alignItems:'center',gap:6}}>
            <i className="ti ti-minus"/> + Separador
          </button>
          <button onClick={salvarOrdemMenu} style={{padding:'8px 18px',borderRadius:6,border:'none',background:C.purple,color:'#fff',fontWeight:700,cursor:'pointer',fontSize:12,display:'flex',alignItems:'center',gap:6}}>
            <i className="ti ti-device-floppy"/> Salvar ordem
          </button>
        </div>
      </div>

    </div>
  );
}


// --- SOLICITAÇÕES -------------------------------------------------------------
const CATEGORIAS_SOL=['Suporte técnico','Financeiro','Comercial','Administrativo'];
const STATUS_SOL=['Aberta','Em andamento','Resolvida','Cancelada'];
const PRIORIDADES_SOL=['Alta','Média','Baixa'];
const COR_PRIOR={'Alta':'#e74c3c','Média':'#e67e22','Baixa':'#27ae60'};
const COR_STATUS={'Aberta':'#3498db','Em andamento':'#e67e22','Resolvida':'#27ae60','Cancelada':'#7f8c8d'};

function SolicitacoesView({solicitacoes,usuarios,todos,currentUser}){
  const [subAba,setSubAba]=useState('kanban');
  const [solSel,setSolSel]=useState(null);
  const [novaForm,setNovaForm]=useState(false);
  const [dragId,setDragId]=useState(null);
  const [dragOverCol,setDragOverCol]=useState(null);

  // Form nova solicitação
  const [form,setForm]=useState({titulo:'',nrBanco:'',clienteNome:'',categoria:'Suporte técnico',prioridade:'Média',descricao:'',responsavelId:''});
  const [salvando,setSalvando]=useState(false);
  const upF=(k,v)=>setForm(x=>({...x,[k]:v}));

  // Comentário
  const [comentario,setComentario]=useState('');

  const fi={padding:'7px 10px',borderRadius:5,border:'1px solid #dde1e7',fontSize:13,color:'#2c3e50',background:'#fff',width:'100%',boxSizing:'border-box'};
  const lbl={fontSize:11,color:'#7f8c8d',display:'block',marginBottom:3,fontWeight:700,textTransform:'uppercase',letterSpacing:.4};
  const sec={background:C.card,borderRadius:8,padding:'16px',marginBottom:12,boxShadow:'0 1px 3px rgba(0,0,0,.06)'};

  async function criarSolicitacao(){
    if(!form.titulo.trim()){alert('Título obrigatório');return;}
    setSalvando(true);
    const ref=doc(collection(db,'solicitacoes'));
    await setDoc(ref,{
      id:ref.id,
      titulo:form.titulo.trim().toUpperCase(),
      nrBanco:form.nrBanco.trim(),
      clienteNome:form.clienteNome.trim().toUpperCase(),
      categoria:form.categoria,
      prioridade:form.prioridade,
      descricao:form.descricao.trim().toUpperCase(),
      responsavelId:form.responsavelId,
      responsavelNome:usuarios.find(u=>u.id===form.responsavelId)?.nome||'',
      status:'Aberta',
      criadoPor:currentUser?.nome||currentUser?.email||'',
      criadoPorId:currentUser?.id||'',
      criadoEm:new Date().toISOString(),
      comentarios:[],
    });
    setForm({titulo:'',nrBanco:'',clienteNome:'',categoria:'Suporte técnico',prioridade:'Média',descricao:'',responsavelId:''});
    setSalvando(false);setSubAba('kanban');
  }

  async function atualizarStatus(id,novoStatus){
    if(novoStatus==='Resolvida'){
      if(!window.confirm('Confirmar resolução desta solicitação? Ela será movida para a aba de Resolvidas.'))return;
    }
    await setDoc(doc(db,'solicitacoes',id),{status:novoStatus},{merge:true});
    if(solSel?.id===id)setSolSel(s=>({...s,status:novoStatus}));
  }

  async function atualizarResponsavel(id,novoRespId){
    const u=usuarios.find(x=>x.id===novoRespId);
    await setDoc(doc(db,'solicitacoes',id),{responsavelId:novoRespId,responsavelNome:u?.nome||''},{merge:true});
    if(solSel?.id===id)setSolSel(s=>({...s,responsavelId:novoRespId,responsavelNome:u?.nome||''}));
  }

  async function adicionarComentario(sol){
    if(!comentario.trim())return;
    const novo={texto:comentario.trim().toUpperCase(),autor:currentUser?.nome||currentUser?.email||'',data:new Date().toISOString()};
    const lista=[...(sol.comentarios||[]),novo];
    await setDoc(doc(db,'solicitacoes',sol.id),{comentarios:lista},{merge:true});
    setSolSel(s=>({...s,comentarios:lista}));
    setComentario('');
  }

  // Drag and drop kanban
  function onDragStart(id){setDragId(id);}
  function onDragOver(e,col){e.preventDefault();setDragOverCol(col);}
  async function onDrop(novoStatus,novoRespId){
    if(!dragId)return;
    const sol=solicitacoes.find(s=>s.id===dragId);
    if(!sol)return;
    if(novoStatus==='Resolvida'){
      if(!window.confirm('Confirmar resolução desta solicitação? Ela será movida para a aba de Resolvidas.'))
        {setDragId(null);setDragOverCol(null);return;}
    }
    const updates={status:novoStatus};
    if(novoRespId&&novoRespId!==sol.responsavelId){
      updates.responsavelId=novoRespId;
      updates.responsavelNome=usuarios.find(u=>u.id===novoRespId)?.nome||'';
    }
    await setDoc(doc(db,'solicitacoes',dragId),updates,{merge:true});
    setDragId(null);setDragOverCol(null);
  }

  const solAtivas=solicitacoes.filter(s=>s.status!=='Resolvida'&&s.status!=='Cancelada');
  const solResolvidas=solicitacoes.filter(s=>s.status==='Resolvida');
  const subAbas=[
    {id:'kanban',   l:`Kanban (${solAtivas.length})`},
    {id:'lista',    l:`Lista (${solicitacoes.length})`},
    {id:'resolvidas',l:`Resolvidas (${solResolvidas.length})`},
  ];

  if(solSel){
    const sol=solicitacoes.find(s=>s.id===solSel.id)||solSel;
    return(
      <div>
        <button onClick={()=>setSolSel(null)} style={{background:'none',border:'none',cursor:'pointer',color:C.blue,fontSize:13,marginBottom:16,display:'flex',alignItems:'center',gap:6,padding:0}}>
          <i className="ti ti-arrow-left"/> Voltar
        </button>
        <div style={sec}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',flexWrap:'wrap',gap:8,marginBottom:12}}>
            <div>
              <div style={{fontWeight:700,fontSize:16,color:C.text,marginBottom:6}}>{sol.titulo}</div>
              <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                <span style={{background:COR_PRIOR[sol.prioridade]+'22',color:COR_PRIOR[sol.prioridade],padding:'2px 10px',borderRadius:10,fontSize:11,fontWeight:700}}>{sol.prioridade}</span>
                <span style={{background:COR_STATUS[sol.status]+'22',color:COR_STATUS[sol.status],padding:'2px 10px',borderRadius:10,fontSize:11,fontWeight:700}}>{sol.status}</span>
                <span style={{background:'#f0f0f0',color:C.textMuted,padding:'2px 10px',borderRadius:10,fontSize:11}}>{sol.categoria}</span>
              </div>
            </div>
            <select value={sol.status} onChange={e=>atualizarStatus(sol.id,e.target.value)} style={{...fi,width:'auto',fontWeight:700,color:COR_STATUS[sol.status],borderColor:COR_STATUS[sol.status]}}>
              {STATUS_SOL.map(s=><option key={s}>{s}</option>)}
            </select>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10,marginBottom:12}}>
            {[['Nº Banco',sol.nrBanco],['Cliente',sol.clienteNome],['Categoria',sol.categoria],['Prioridade',sol.prioridade],['Aberta por',sol.criadoPor],['Data',sol.criadoEm?new Date(sol.criadoEm).toLocaleDateString('pt-BR'):'']].map(([l,v])=>(
              <div key={l} style={{background:'#f8f9fa',borderRadius:5,padding:'8px 10px'}}>
                <div style={{fontSize:9,color:C.textMuted,fontWeight:700,textTransform:'uppercase'}}>{l}</div>
                <div style={{fontSize:12,fontWeight:600,color:C.text,marginTop:2}}>{v||'—'}</div>
              </div>
            ))}
          </div>
          <div style={{marginBottom:12}}>
            <label style={lbl}>Responsável</label>
            <select value={sol.responsavelId||''} onChange={e=>atualizarResponsavel(sol.id,e.target.value)} style={fi}>
              <option value="">— Sem responsável —</option>
              {usuarios.map(u=><option key={u.id} value={u.id}>{u.nome||u.email}</option>)}
            </select>
          </div>
          {sol.descricao&&<div style={{background:'#f8f9fa',borderRadius:6,padding:'12px',fontSize:13,color:C.text,marginBottom:12,whiteSpace:'pre-wrap'}}>{sol.descricao}</div>}
        </div>
        <div style={sec}>
          <div style={{fontWeight:700,fontSize:12,color:C.text,marginBottom:12,textTransform:'uppercase'}}>Comentários ({(sol.comentarios||[]).length})</div>
          {(sol.comentarios||[]).map((cm,i)=>(
            <div key={i} style={{borderLeft:`3px solid ${C.blue}`,paddingLeft:12,marginBottom:12}}>
              <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:4}}>
                <div style={{width:24,height:24,borderRadius:'50%',background:C.blue,display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontSize:10,fontWeight:700,flexShrink:0}}>{(cm.autor||'?')[0].toUpperCase()}</div>
                <span style={{fontSize:11,fontWeight:700,color:C.text}}>{cm.autor}</span>
                <span style={{fontSize:10,color:C.textMuted}}>{cm.data?new Date(cm.data).toLocaleString('pt-BR'):''}</span>
              </div>
              <div style={{fontSize:12,color:C.text,marginLeft:32}}>{cm.texto}</div>
            </div>
          ))}
          {(sol.comentarios||[]).length===0&&<div style={{fontSize:12,color:C.textMuted,marginBottom:12}}>Nenhum comentário ainda.</div>}
          <div style={{display:'flex',gap:8}}>
            <textarea value={comentario} onChange={e=>setComentario(e.target.value.toUpperCase())} placeholder="ADICIONAR COMENTÁRIO..." style={{...fi,resize:'vertical',minHeight:60,flex:1,textTransform:'uppercase'}}/>
            <button onClick={()=>adicionarComentario(sol)} style={{padding:'8px 14px',borderRadius:5,border:'none',background:C.blue,color:'#fff',fontWeight:700,cursor:'pointer',fontSize:12,alignSelf:'flex-end'}}>Enviar</button>
          </div>
        </div>
      </div>
    );
  }

  return(
    <div>
      {/* Header com botão Nova Solicitação destacado */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16,flexWrap:'wrap',gap:10}}>
        <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
          {subAbas.map(s=>(
            <button key={s.id} onClick={()=>setSubAba(s.id)} style={{padding:'7px 16px',borderRadius:6,border:'none',background:subAba===s.id?C.blue:'#ecf0f1',color:subAba===s.id?'#fff':C.textMuted,cursor:'pointer',fontSize:12,fontWeight:subAba===s.id?700:400}}>
              {s.l}
            </button>
          ))}
          <span style={{fontSize:11,color:C.textMuted,marginLeft:4}}>
            {solicitacoes.filter(s=>s.status==='Aberta').length} abertas • {solicitacoes.filter(s=>s.status==='Em andamento').length} em andamento
          </span>
        </div>
        <button onClick={()=>setSubAba('nova')} style={{padding:'10px 22px',borderRadius:7,border:'none',background:C.green,color:'#fff',fontWeight:700,cursor:'pointer',fontSize:13,display:'flex',alignItems:'center',gap:8,boxShadow:'0 2px 8px rgba(39,174,96,.4)'}}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
          Nova solicitação
        </button>
      </div>



      {/* NOVA SOLICITAÇÃO (aba) */}
      {subAba==='nova'&&(
        <div style={sec}>
          <div style={{fontWeight:700,fontSize:14,color:C.green,marginBottom:16,display:'flex',alignItems:'center',gap:8}}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
            Nova solicitação
          </div>
          <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:10,marginBottom:10}}>
            <div><label style={lbl}>Título *</label><input style={{...fi,textTransform:'uppercase'}} value={form.titulo} onChange={e=>upF('titulo',e.target.value.toUpperCase())}/></div>
            <div><label style={lbl}>Nº Banco (Secullum)</label><input style={fi} value={form.nrBanco} onChange={e=>upF('nrBanco',e.target.value)}/></div>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
            <div><label style={lbl}>Cliente</label>
              <input style={{...fi,textTransform:'uppercase'}} value={form.clienteNome} onChange={e=>upF('clienteNome',e.target.value.toUpperCase())} placeholder="NOME DO CLIENTE"/>
            </div>
            <div><label style={lbl}>Responsável *</label>
              <select style={fi} value={form.responsavelId} onChange={e=>upF('responsavelId',e.target.value)}>
                <option value="">— Selecione o responsável —</option>
                {usuarios.map(u=><option key={u.id} value={u.id}>{u.nome||u.email}</option>)}
              </select>
            </div>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
            <div><label style={lbl}>Categoria</label>
              <select style={fi} value={form.categoria} onChange={e=>upF('categoria',e.target.value)}>
                {CATEGORIAS_SOL.map(c=><option key={c}>{c}</option>)}
              </select>
            </div>
            <div><label style={lbl}>Prioridade</label>
              <select style={fi} value={form.prioridade} onChange={e=>upF('prioridade',e.target.value)}>
                {PRIORIDADES_SOL.map(p=><option key={p}>{p}</option>)}
              </select>
            </div>
          </div>
          <div style={{marginBottom:14}}>
            <label style={lbl}>Descreva a solicitação</label>
            <textarea value={form.descricao} onChange={e=>upF('descricao',e.target.value.toUpperCase())} style={{...fi,resize:'vertical',minHeight:80,textTransform:'uppercase'}} placeholder="DESCREVA AQUI OS DETALHES DA SOLICITAÇÃO..."/>
          </div>
          <div style={{display:'flex',gap:8}}>
            <button onClick={criarSolicitacao} disabled={salvando} style={{padding:'10px 22px',borderRadius:7,border:'none',background:C.green,color:'#fff',fontWeight:700,cursor:'pointer',fontSize:13,display:'flex',alignItems:'center',gap:6,boxShadow:'0 2px 8px rgba(39,174,96,.4)'}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
              {salvando?'Salvando...':'Abrir solicitação'}
            </button>
            <button onClick={()=>setSubAba('kanban')} style={{padding:'10px 16px',borderRadius:7,border:'1px solid #dde1e7',background:'#fff',cursor:'pointer',fontSize:12,color:C.textMuted}}>Cancelar</button>
          </div>
        </div>
      )}

      {/* RESOLVIDAS */}
      {subAba==='resolvidas'&&(
        <div>
          {solResolvidas.length===0&&<div style={{background:C.card,borderRadius:8,padding:'30px',textAlign:'center',color:C.textMuted,fontSize:13,boxShadow:'0 1px 3px rgba(0,0,0,.08)'}}>Nenhuma solicitação resolvida ainda.</div>}
          {[...solResolvidas].sort((a,b)=>new Date(b.criadoEm)-new Date(a.criadoEm)).map((s,i)=>(
            <div key={s.id} onClick={()=>setSolSel(s)} style={{padding:'12px 16px',marginBottom:8,cursor:'pointer',background:C.card,borderRadius:8,boxShadow:'0 1px 3px rgba(0,0,0,.06)',display:'flex',alignItems:'center',gap:12,opacity:.8}}>
              <div style={{width:4,height:36,borderRadius:2,background:C.green,flexShrink:0}}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:700,fontSize:12,color:C.text,marginBottom:2,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{s.titulo}</div>
                <div style={{fontSize:11,color:C.textMuted}}>{s.categoria}{s.clienteNome?' • '+s.clienteNome:''}{s.responsavelNome?' • '+s.responsavelNome:''}</div>
              </div>
              <span style={{background:'#d5f5e3',color:C.green,padding:'2px 10px',borderRadius:10,fontSize:10,fontWeight:700,flexShrink:0}}>✓ Resolvida</span>
            </div>
          ))}
        </div>
      )}

      {/* LISTA */}
      {subAba==='lista'&&(
        <div style={{background:C.card,borderRadius:8,boxShadow:'0 1px 3px rgba(0,0,0,.08)',overflow:'hidden'}}>
          {solicitacoes.length===0&&<div style={{padding:'30px',textAlign:'center',color:C.textMuted,fontSize:13}}>Nenhuma solicitação cadastrada.</div>}
          {[...solicitacoes].sort((a,b)=>new Date(b.criadoEm)-new Date(a.criadoEm)).map((s,i)=>(
            <div key={s.id} onClick={()=>setSolSel(s)} style={{padding:'12px 16px',borderBottom:`1px solid ${C.border}`,cursor:'pointer',background:i%2===0?'#fff':'#fdfdfd',display:'flex',alignItems:'center',gap:12}}>
              <div style={{width:4,height:40,borderRadius:2,background:COR_PRIOR[s.prioridade],flexShrink:0}}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:700,fontSize:12,color:C.text,marginBottom:3,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{s.titulo}</div>
                <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                  <span style={{fontSize:10,color:C.textMuted}}>{s.categoria}</span>
                  {s.clienteNome&&<span style={{fontSize:10,color:C.textMuted}}>• {s.clienteNome}</span>}
                  {s.nrBanco&&<span style={{fontSize:10,color:C.textMuted}}>• Banco: {s.nrBanco}</span>}
                </div>
              </div>
              <div style={{display:'flex',gap:6,alignItems:'center',flexShrink:0}}>
                <span style={{background:COR_STATUS[s.status]+'22',color:COR_STATUS[s.status],padding:'2px 8px',borderRadius:10,fontSize:10,fontWeight:700}}>{s.status}</span>
                {s.responsavelNome&&<span style={{fontSize:10,color:C.textMuted}}>{s.responsavelNome}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* KANBAN */}
      {subAba==='kanban'&&(
        <div>
          {/* Kanban por usuário - apenas ativas */}
          <div style={{overflowX:'auto',paddingBottom:8}}>
            <div style={{display:'flex',gap:12,minWidth:'max-content'}}>
              {usuarios.map(u=>{
                const solUser=solAtivas.filter(s=>s.responsavelId===u.id);
                const isOver=dragOverCol===u.id;
                return(
                  <div key={u.id} onDragOver={e=>onDragOver(e,u.id)} onDrop={()=>onDrop(solUser.find(s=>s.id===dragId)?.status||'Aberta',u.id)}
                    style={{width:240,flexShrink:0,background:'#f8f9fa',borderRadius:8,padding:'10px',border:isOver?`2px dashed ${C.blue}`:'2px solid transparent',transition:'border .15s'}}>
                    {/* Cabeçalho da coluna */}
                    <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12,padding:'6px 8px',background:'#fff',borderRadius:6,boxShadow:'0 1px 3px rgba(0,0,0,.06)'}}>
                      <div style={{width:30,height:30,borderRadius:'50%',background:C.blue,display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontSize:12,fontWeight:700,flexShrink:0}}>{(u.nome||u.email||'?')[0].toUpperCase()}</div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontWeight:700,fontSize:12,color:C.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{u.nome||u.email}</div>
                        <div style={{fontSize:10,color:C.textMuted}}>{solUser.length} solicitação(ões)</div>
                      </div>
                    </div>
                    {/* Cards por status dentro da coluna */}
                    {STATUS_SOL.filter(st=>st!=='Cancelada').map(st=>{
                      const cards=solUser.filter(s=>s.status===st);
                      if(cards.length===0)return null;
                      return(
                        <div key={st} style={{marginBottom:8}}>
                          <div style={{fontSize:9,fontWeight:700,color:COR_STATUS[st],textTransform:'uppercase',marginBottom:4,paddingLeft:4}}>{st} ({cards.length})</div>
                          {cards.map(s=>(
                            <div key={s.id} draggable onDragStart={()=>onDragStart(s.id)}
                              onClick={()=>setSolSel(s)}
                              style={{background:'#fff',borderRadius:6,padding:'8px 10px',marginBottom:6,cursor:'pointer',boxShadow:'0 1px 3px rgba(0,0,0,.06)',borderLeft:`3px solid ${COR_PRIOR[s.prioridade]}`,opacity:dragId===s.id?.5:1,transition:'opacity .15s'}}>
                              <div style={{fontSize:11,fontWeight:700,color:C.text,marginBottom:4,lineHeight:1.3,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{s.titulo}</div>
                              <div style={{display:'flex',gap:4,flexWrap:'wrap',marginBottom:s.clienteNome?4:0}}>
                                <span style={{background:COR_PRIOR[s.prioridade]+'22',color:COR_PRIOR[s.prioridade],padding:'1px 6px',borderRadius:8,fontSize:9,fontWeight:700}}>{s.prioridade}</span>
                                <span style={{background:'#f0f0f0',color:C.textMuted,padding:'1px 6px',borderRadius:8,fontSize:9}}>{s.categoria}</span>
                              </div>
                              {s.clienteNome&&<div style={{fontSize:10,color:C.textMuted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>👤 {s.clienteNome}</div>}
                              {s.nrBanco&&<div style={{fontSize:10,color:C.textMuted}}>🏦 {s.nrBanco}</div>}
                              {(s.comentarios||[]).length>0&&<div style={{fontSize:9,color:C.textMuted,marginTop:3}}>💬 {s.comentarios.length}</div>}
                              <div style={{fontSize:8,color:'#bdc3c7',marginTop:4,textAlign:'right'}}>⠿ arrastar</div>
                            </div>
                          ))}
                        </div>
                      );
                    })}
                    {solUser.filter(s=>s.status!=='Cancelada').length===0&&(
                      <div style={{fontSize:11,color:'#bdc3c7',textAlign:'center',padding:'20px 0'}}>{isOver?'Soltar aqui':'Sem solicitações'}</div>
                    )}
                  </div>
                );
              })}
              {usuarios.length===0&&<div style={{fontSize:13,color:C.textMuted,padding:'30px'}}>Nenhum usuário cadastrado. Adicione usuários em Configurações.</div>}
            </div>
          </div>


        </div>
      )}
    </div>
  );
}


// --- SOM DE SINO -------------------------------------------------------------
function tocarSino(vezes=3){
  try{
    const ctx=new (window.AudioContext||window.webkitAudioContext)();
    let t=ctx.currentTime;
    for(let i=0;i<vezes;i++){
      const osc=ctx.createOscillator();
      const gain=ctx.createGain();
      osc.connect(gain);gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(880,t);
      osc.frequency.exponentialRampToValueAtTime(440,t+0.3);
      gain.gain.setValueAtTime(0.3,t);
      gain.gain.exponentialRampToValueAtTime(0.001,t+0.4);
      osc.start(t);osc.stop(t+0.4);
      t+=0.5;
    }
  }catch(e){}
}


// --- DASHBOARD VIEW -----------------------------------------------------------
function DashboardView({todos,cl,fat,agd,totFat,totAgd,totGeral,totSist,totEquip,totImpl,porMes,porVend,porPlano,maxVend,solicitacoes,implantacoes,clientes,metaSistema,metaEquip,salvarMetaSistema,salvarMetaEquip,setPage,setClienteSel,setFiltroStatus,filtroVendedor,setFiltroVendedor}){
const [dashAba,setDashAba]=useState('resumo');
const hoje2=new Date();hoje2.setHours(0,0,0,0);
const nPagos=todos.filter(c=>c.equipPago==='Não pago');
const solAbertasQtd=solicitacoes.filter(s=>s.status==='Aberta'||s.status==='Em andamento').length;
const implAtrasQtd=todos.filter(c=>{const impl=implantacoes[c.id]||{};if(impl.etapa==='processo_finalizado')return false;if(!impl.prazo)return false;return new Date(impl.prazo+'T12:00:00')<hoje2;}).length;
const pctFat=Math.round((fat.length/Math.max(cl.length,1))*100);
const pctAgd=Math.round((agd.length/Math.max(cl.length,1))*100);

// Card estilo Secullum
const SCard=({label,value,sub,pct,cor,onClick})=>(
  <div onClick={onClick} style={{background:'#fff',borderRadius:8,padding:'14px 16px',boxShadow:'0 1px 4px rgba(0,0,0,.07)',cursor:onClick?'pointer':'default',borderTop:`3px solid ${cor||'#f5a623'}`,transition:'box-shadow .15s',minWidth:0}}>
    <div style={{fontSize:10,color:'#7f8c8d',fontWeight:600,textTransform:'uppercase',letterSpacing:.7,marginBottom:6,lineHeight:1.3}}>{label}</div>
    <div style={{fontSize:20,fontWeight:700,color:'#4a4a4a',lineHeight:1,marginBottom:4,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{value}</div>
    {sub&&<div style={{fontSize:10,color:'#7f8c8d',marginBottom:pct!==undefined?6:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{sub}</div>}
    {pct!==undefined&&<>
      <div style={{height:3,borderRadius:2,background:'#f0f0f0',overflow:'hidden'}}>
        <div style={{height:'100%',borderRadius:2,background:cor||'#f5a623',width:Math.min(pct,100)+'%',transition:'width .4s'}}/>
      </div>
      <div style={{fontSize:10,color:'#7f8c8d',marginTop:3}}>{pct}%</div>
    </>}
  </div>
);

return(
  <div>
    {/* Alertas e metas sempre visíveis */}
    <PainelAlertas todos={todos} implantacoes={implantacoes} onVerImplantacao={()=>{setPage('implantacao');setClienteSel(null);}}/>
    {nPagos.length>0&&(
      <div style={{background:'#fff8ee',border:'1px solid #fde68a',borderRadius:8,padding:'10px 14px',marginBottom:8}}>
        <div style={{fontWeight:700,fontSize:12,color:'#b45309',marginBottom:6,display:'flex',alignItems:'center',gap:6}}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l2-1.14"/><path d="m7.5 4.27 9 5.15"/><polyline points="3.29 7 12 12 20.71 7"/><line x1="12" y1="22" x2="12" y2="12"/><circle cx="18.5" cy="15.5" r="2.5"/><path d="M20.27 17.27 22 19"/></svg>
          {nPagos.length} equipamento(s) aguardando pagamento
        </div>
        <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
          {nPagos.slice(0,8).map(c=>(
            <div key={c.id} onClick={()=>setClienteSel(c)} style={{background:'#fff',border:'1px solid #fde68a',borderRadius:5,padding:'3px 10px',cursor:'pointer',fontSize:11}}>
              <span style={{fontWeight:600,color:'#4a4a4a'}}>{c.nome}</span>
              <span style={{color:'#7f8c8d',marginLeft:6}}>{c.equipTipo}</span>
            </div>
          ))}
          {nPagos.length>8&&<span style={{fontSize:11,color:'#7f8c8d',alignSelf:'center'}}>+{nPagos.length-8} mais</span>}
        </div>
      </div>
    )}
    <DuplasMetas todos={todos} metaSistema={metaSistema} metaEquip={metaEquip} onSetMetaSistema={salvarMetaSistema} onSetMetaEquip={salvarMetaEquip}/>

    {/* Abas estilo Secullum */}
    <div style={{background:'#fff',borderRadius:'8px 8px 0 0',borderBottom:'2px solid #e8eaed',marginBottom:0,display:'flex',gap:0}}>
      {[
        {id:'resumo',    l:'RESUMO DIÁRIO'},
        {id:'financeiro',l:'FINANCEIRO'},
        {id:'clientes',  l:'CLIENTES'},
        {id:'implantacao',l:'IMPLANTAÇÃO'},
      ].map(a=>(
        <button key={a.id} onClick={()=>setDashAba(a.id)} style={{padding:'12px 20px',border:'none',borderBottom:dashAba===a.id?'3px solid #f5a623':'3px solid transparent',background:'transparent',cursor:'pointer',fontSize:11,fontWeight:dashAba===a.id?700:500,color:dashAba===a.id?'#f5a623':'#7f8c8d',letterSpacing:.8,marginBottom:-2,transition:'all .15s'}}>
          {a.l}
        </button>
      ))}
    </div>

    {/* ABA RESUMO */}
    {dashAba==='resumo'&&(
      <div style={{background:'#fff',borderRadius:'0 0 8px 8px',padding:'20px',boxShadow:'0 1px 4px rgba(0,0,0,.07)'}}>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(120px,1fr))',gap:10,marginBottom:14}}>
          <SCard label="Total de Clientes" value={cl.length} sub={`${fat.length} fat. / ${agd.length} agd.`} pct={pctFat} cor="#f5a623"/>
          <SCard label="Clientes Faturados" value={fat.length} sub={moeda(totFat)} pct={pctFat} cor="#27ae60" onClick={()=>setFiltroStatus('Faturado')}/>
          <SCard label="Aguardando Faturar" value={agd.length} sub={moeda(totAgd)} pct={pctAgd} cor="#e74c3c" onClick={()=>setFiltroStatus('Aguardando')}/>
          <SCard label="Receita Total" value={moeda(totGeral)} cor="#3498db"/>
          <SCard label="Receita Sistema" value={moeda(totSist)} cor="#9b59b6"/>
          <SCard label="Receita Equipamentos" value={moeda(totEquip)} cor="#1abc9c"/>
          <SCard label="Solicitações Abertas" value={solAbertasQtd} cor="#f5a623" onClick={()=>setPage('solicitacoes')}/>
          <SCard label="Implantações Atrasadas" value={implAtrasQtd} cor="#e74c3c" onClick={()=>setPage('implantacao')}/>
        </div>
        <GraficoMRR todos={todos}/>
        <div style={{display:'grid',gridTemplateColumns:'2fr 1fr 1fr',gap:14,marginTop:14}}>
          <div style={{background:'#fff',borderRadius:8,padding:'16px',border:'1px solid #e8eaed'}}>
            <div style={{fontWeight:700,fontSize:11,color:'#4a4a4a',marginBottom:8,textTransform:'uppercase',letterSpacing:.8}}>Faturamento por mês</div>
            <BarChart data={porMes.map(p=>({l:MESES[p.m].slice(0,3),v:p.fat}))} color="#f5a623" height={110}/>
          </div>
          <div style={{background:'#fff',borderRadius:8,padding:'16px',border:'1px solid #e8eaed'}}>
            <div style={{fontWeight:700,fontSize:11,color:'#4a4a4a',marginBottom:10,textTransform:'uppercase',letterSpacing:.8}}>Por plano</div>
            <div style={{display:'flex',alignItems:'center',gap:12}}>
              <Donut vals={porPlano.map(p=>p.qtd)} colors={['#3498db','#9b59b6','#f5a623']} size={80} label={cl.length} sub="total"/>
              <div>{porPlano.map(({p,qtd},i)=>{const cors=['#3498db','#9b59b6','#f5a623'];return <div key={p} style={{display:'flex',alignItems:'center',gap:6,marginBottom:4}}><div style={{width:8,height:8,borderRadius:2,background:cors[i]}}/><span style={{fontSize:11,color:'#7f8c8d',flex:1}}>{p}</span><span style={{fontSize:12,fontWeight:700,color:'#4a4a4a'}}>{qtd}</span></div>;})}</div>
            </div>
          </div>
          <div style={{background:'#fff',borderRadius:8,padding:'16px',border:'1px solid #e8eaed'}}>
            <div style={{fontWeight:700,fontSize:11,color:'#4a4a4a',marginBottom:10,textTransform:'uppercase',letterSpacing:.8}}>Status</div>
            <div style={{display:'flex',alignItems:'center',gap:12}}>
              <Donut vals={[fat.length,agd.length]} colors={['#27ae60','#f5a623']} size={80} label={`${pctFat}%`} sub="fat."/>
              <div>{[{l:'Faturado',v:fat.length,c:'#27ae60'},{l:'Aguardando',v:agd.length,c:'#f5a623'}].map(x=><div key={x.l} style={{display:'flex',alignItems:'center',gap:6,marginBottom:4}}><div style={{width:8,height:8,borderRadius:2,background:x.c}}/><span style={{fontSize:11,color:'#7f8c8d',flex:1}}>{x.l}</span><span style={{fontSize:12,fontWeight:700,color:'#4a4a4a'}}>{x.v}</span></div>)}</div>
            </div>
          </div>
        </div>
      </div>
    )}

    {/* ABA FINANCEIRO */}
    {dashAba==='financeiro'&&(
      <div style={{background:'#fff',borderRadius:'0 0 8px 8px',padding:'20px',boxShadow:'0 1px 4px rgba(0,0,0,.07)'}}>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(130px,1fr))',gap:12,marginBottom:16}}>
          <SCard label="Total Geral" value={moeda(totGeral)} cor="#f5a623"/>
          <SCard label="Faturado" value={moeda(totFat)} sub={fat.length+' clientes'} pct={Math.round((totFat/Math.max(totGeral,1))*100)} cor="#27ae60" onClick={()=>setFiltroStatus('Faturado')}/>
          <SCard label="A Faturar" value={moeda(totAgd)} sub={agd.length+' pendentes'} cor="#e74c3c" onClick={()=>setFiltroStatus('Aguardando')}/>
          <SCard label="Sistema/Mês" value={moeda(totSist)} cor="#9b59b6"/>
          <SCard label="Equipamentos" value={moeda(totEquip)} cor="#1abc9c"/>
          <SCard label="Implantações" value={moeda(totImpl)} cor="#3498db"/>
        </div>
        <div style={{background:'#fff',borderRadius:8,padding:'16px',border:'1px solid #e8eaed',marginBottom:14}}>
          <div style={{fontWeight:700,fontSize:11,color:'#4a4a4a',marginBottom:12,textTransform:'uppercase',letterSpacing:.8}}>Ranking financeiro — vendedores</div>
          {porVend.map(({v,qtd,total,fat:fatV},rank)=>{const medals=['🥇','🥈','🥉'];const pctV=Math.round((fatV/Math.max(maxVend,1))*100);
            return <div key={v} onClick={()=>setFiltroVendedor(filtroVendedor===v?'Todos':v)} style={{display:'flex',alignItems:'center',gap:10,padding:'8px',borderRadius:6,marginBottom:4,cursor:'pointer',background:filtroVendedor===v?'#fff8ee':'transparent'}}>
              <span style={{fontSize:16,width:22}}>{medals[rank]||'🎖'}</span>
              <div style={{width:30,height:30,borderRadius:'50%',background:'#f5a623',display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontSize:11,fontWeight:700,flexShrink:0}}>{v[0]}</div>
              <div style={{flex:1}}>
                <div style={{display:'flex',justifyContent:'space-between',fontSize:12}}><span style={{fontWeight:600,color:'#4a4a4a'}}>{v}</span><span style={{fontWeight:700,color:'#27ae60'}}>{moeda(fatV)}</span></div>
                <div style={{height:4,borderRadius:2,background:'#f0f0f0',marginTop:4}}><div style={{height:'100%',borderRadius:2,background:'#f5a623',width:pctV+'%'}}/></div>
                <div style={{fontSize:10,color:'#7f8c8d',marginTop:1}}>{qtd} clientes</div>
              </div>
            </div>;
          })}
        </div>
        {agd.length>0&&(
          <div style={{background:'#fff',borderRadius:8,border:'2px solid #fde68a',overflow:'hidden'}}>
            <div style={{background:'#fff8ee',padding:'10px 16px',borderBottom:'1px solid #fde68a',display:'flex',justifyContent:'space-between'}}>
              <span style={{fontWeight:700,fontSize:11,color:'#b45309',textTransform:'uppercase',letterSpacing:.8}}>⏳ Aguardando faturamento</span>
              <span style={{fontWeight:700,color:'#b45309'}}>{moeda(totAgd)}</span>
            </div>
            <table style={{width:'100%',borderCollapse:'collapse'}}>
              <thead><tr style={{background:'#f5f6fa'}}>{['Empresa','Vendedor','Plano','Valor'].map(h=><th key={h} style={{padding:'7px 14px',textAlign:'left',fontSize:10,color:'#7f8c8d',fontWeight:700,textTransform:'uppercase',letterSpacing:.6}}>{h}</th>)}</tr></thead>
              <tbody>{sortRecente(agd).map((c,i)=>(
                <tr key={c.id} onClick={()=>setClienteSel(c)} style={{borderTop:'1px solid #e8eaed',cursor:'pointer',background:i%2===0?'#fff':'#fffef5'}}>
                  <td style={{padding:'8px 14px',fontSize:12,fontWeight:600,color:'#4a4a4a',maxWidth:180,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{c.nome}</td>
                  <td style={{padding:'8px 14px',fontSize:11,color:'#7f8c8d'}}>{c.vendedor}</td>
                  <td style={{padding:'8px 14px'}}><span style={{background:'#fff8ee',color:'#f5a623',padding:'2px 7px',borderRadius:10,fontSize:10,fontWeight:700}}>{c.plano}</span></td>
                  <td style={{padding:'8px 14px',fontSize:12,fontWeight:700,color:'#f5a623'}}>{moeda(c.total)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    )}

    {/* ABA CLIENTES */}
    {dashAba==='clientes'&&(
      <div style={{background:'#fff',borderRadius:'0 0 8px 8px',padding:'0',boxShadow:'0 1px 4px rgba(0,0,0,.07)',overflow:'hidden'}}>
        <div style={{padding:'12px 16px',borderBottom:'1px solid #e8eaed',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <span style={{fontWeight:700,fontSize:13,color:'#4a4a4a'}}>{cl.length} clientes</span>
          <button onClick={()=>setPage('clientes')} style={{background:'#f5a623',color:'#fff',border:'none',borderRadius:5,padding:'6px 14px',cursor:'pointer',fontSize:11,fontWeight:700}}>Ver todos →</button>
        </div>
        <table style={{width:'100%',borderCollapse:'collapse'}}>
          <thead><tr style={{background:'#f5f6fa'}}>
            {['Empresa','CNPJ','Plano','Vendedor','Status','Valor'].map(h=><th key={h} style={{padding:'8px 12px',textAlign:'left',fontSize:10,color:'#7f8c8d',fontWeight:700,textTransform:'uppercase',letterSpacing:.6}}>{h}</th>)}
          </tr></thead>
          <tbody>
            {sortRecente(cl).slice(0,15).map((c,i)=>(
              <tr key={c.id} onClick={()=>{setClienteSel(c);}} style={{borderTop:'1px solid #e8eaed',cursor:'pointer',background:i%2===0?'#fff':'#fafafa'}}>
                <td style={{padding:'9px 12px',fontSize:12,fontWeight:600,color:'#4a4a4a',maxWidth:180,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{c.nome}</td>
                <td style={{padding:'9px 12px',fontSize:11,color:'#7f8c8d'}}>{c.cnpj}</td>
                <td style={{padding:'9px 12px'}}><span style={{background:'#fff8ee',color:'#f5a623',padding:'2px 8px',borderRadius:10,fontSize:10,fontWeight:700}}>{c.plano}</span></td>
                <td style={{padding:'9px 12px',fontSize:11,color:'#7f8c8d'}}>{c.vendedor}</td>
                <td style={{padding:'9px 12px'}}><span style={{background:c.status==='Faturado'?'#d5f5e3':'#fff8ee',color:c.status==='Faturado'?'#27ae60':'#f5a623',padding:'2px 8px',borderRadius:10,fontSize:10,fontWeight:700}}>{c.status==='Faturado'?'✓ Fat.':'⏳ Agd.'}</span></td>
                <td style={{padding:'9px 12px',fontSize:12,fontWeight:700,color:'#4a4a4a'}}>{moeda(c.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}

    {/* ABA IMPLANTAÇÃO */}
    {dashAba==='implantacao'&&(
      <div style={{background:'#fff',borderRadius:'0 0 8px 8px',padding:'20px',boxShadow:'0 1px 4px rgba(0,0,0,.07)'}}>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(120px,1fr))',gap:10,marginBottom:14}}>
          {ETAPAS.map(e=>{
            const qtd=todos.filter(c=>(implantacoes[c.id]||{}).etapa===e.id).length;
            return <div key={e.id} style={{background:'#fff',borderRadius:8,padding:'14px 16px',border:'1px solid #e8eaed',borderLeft:`3px solid ${e.color}`}}>
              <div style={{fontSize:10,color:'#7f8c8d',fontWeight:600,textTransform:'uppercase',letterSpacing:.6,marginBottom:6}}>{e.label}</div>
              <div style={{fontSize:26,fontWeight:700,color:'#4a4a4a'}}>{qtd}</div>
            </div>;
          })}
        </div>
        <button onClick={()=>setPage('implantacao')} style={{background:'#f5a623',color:'#fff',border:'none',borderRadius:6,padding:'9px 20px',cursor:'pointer',fontSize:12,fontWeight:700}}>
          Abrir Kanban completo →
        </button>
      </div>
    )}
  </div>
);
}


// ===========================================================================
// MÓDULO DE ORÇAMENTOS
// ===========================================================================

const STATUS_ORC=[
  {id:'rascunho',   label:'Rascunho',       color:'#7f8c8d'},
  {id:'enviado',    label:'Enviado',         color:'#3498db'},
  {id:'negociacao', label:'Em negociação',   color:'#f5a623'},
  {id:'fechado',    label:'Fechado',         color:'#27ae60'},
  {id:'perdido',    label:'Perdido',         color:'#e74c3c'},
];
const COR_ORC={rascunho:'#7f8c8d',enviado:'#3498db',negociacao:'#f5a623',fechado:'#27ae60',perdido:'#e74c3c'};

// --- EDITOR RICO --------------------------------------------------------------
function RichEditor({value,onChange,minHeight=120,placeholder=''}){
  const ref=useRef(null);
  const init=useRef(false);
  useEffect(()=>{
    if(ref.current&&!init.current){
      ref.current.innerHTML=value||'';
      init.current=true;
    }
  },[]);
  function cmd(c,v=null){ref.current.focus();document.execCommand(c,false,v);onChange(ref.current.innerHTML);}
  function handlePaste(e){
    const items=e.clipboardData?.items||[];
    for(let i=0;i<items.length;i++){
      if(items[i].type.startsWith('image/')){
        e.preventDefault();
        const r=new FileReader();
        r.onload=ev=>{cmd('insertImage',ev.target.result);};
        r.readAsDataURL(items[i].getAsFile());
        return;
      }
    }
  }
  const B={padding:'3px 7px',border:'1px solid #dde1e7',borderRadius:4,background:'#fff',cursor:'pointer',fontSize:12,color:'#4a4a4a',display:'inline-flex',alignItems:'center',justifyContent:'center'};
  return(
    <div style={{border:'1px solid #dde1e7',borderRadius:6,overflow:'hidden'}}>
      <div style={{display:'flex',gap:2,padding:'5px 8px',background:'#f5f6fa',borderBottom:'1px solid #dde1e7',flexWrap:'wrap',alignItems:'center'}}>
        <button style={{...B,fontWeight:700}} onMouseDown={e=>{e.preventDefault();cmd('bold');}}>B</button>
        <button style={{...B,fontStyle:'italic'}} onMouseDown={e=>{e.preventDefault();cmd('italic');}}>I</button>
        <button style={{...B,textDecoration:'underline'}} onMouseDown={e=>{e.preventDefault();cmd('underline');}}>U</button>
        <div style={{width:1,background:'#dde1e7',height:18,margin:'0 3px'}}/>
        <select onChange={e=>{if(e.target.value)cmd('fontSize',e.target.value);e.target.value='';}} style={{...B,padding:'2px 4px',fontSize:11}}>
          <option value="">Tam</option>
          {[1,2,3,4,5,6,7].map(s=><option key={s} value={s}>{s}</option>)}
        </select>
        <input type="color" title="Cor" onInput={e=>cmd('foreColor',e.target.value)} style={{width:26,height:24,border:'1px solid #dde1e7',borderRadius:4,cursor:'pointer',padding:1}}/>
        <div style={{width:1,background:'#dde1e7',height:18,margin:'0 3px'}}/>
        <button style={B} title="Esquerda" onMouseDown={e=>{e.preventDefault();cmd('justifyLeft');}}>⬤</button>
        <button style={B} title="Centro" onMouseDown={e=>{e.preventDefault();cmd('justifyCenter');}}>≡</button>
        <button style={B} title="Direita" onMouseDown={e=>{e.preventDefault();cmd('justifyRight');}}>⬤</button>
        <div style={{width:1,background:'#dde1e7',height:18,margin:'0 3px'}}/>
        <button style={B} title="Lista" onMouseDown={e=>{e.preventDefault();cmd('insertUnorderedList');}}>•≡</button>
        <button style={B} title="Numerada" onMouseDown={e=>{e.preventDefault();cmd('insertOrderedList');}}>1≡</button>
        <div style={{width:1,background:'#dde1e7',height:18,margin:'0 3px'}}/>
        <button style={B} title="Inserir imagem por URL" onMouseDown={e=>{e.preventDefault();const u=prompt('URL da imagem:');if(u)cmd('insertImage',u);}}>🖼</button>
        <button style={B} title="Link" onMouseDown={e=>{e.preventDefault();const u=prompt('URL:');if(u)cmd('createLink',u);}}>🔗</button>
        <button style={{...B,color:'#e74c3c'}} title="Limpar" onMouseDown={e=>{e.preventDefault();cmd('removeFormat');}}>✕</button>
      </div>
      <div ref={ref} contentEditable suppressContentEditableWarning
        onInput={()=>onChange(ref.current.innerHTML)}
        onPaste={handlePaste}
        style={{minHeight,padding:'10px 12px',outline:'none',fontSize:13,color:'#4a4a4a',lineHeight:1.6}}
      />
    </div>
  );
}

// --- CONFIG: SERVIÇOS ---------------------------------------------------------
function OrcConfigServicos({servicos}){
  const [form,setForm]=useState({nome:'',descricao:'',valor:''});
  const [editId,setEditId]=useState(null);
  const [saved,setSaved]=useState(false);
  const fi={padding:'8px 10px',borderRadius:5,border:'1px solid #dde1e7',fontSize:13,color:'#4a4a4a',background:'#fff',width:'100%',boxSizing:'border-box'};
  const lbl={fontSize:11,color:'#7f8c8d',display:'block',marginBottom:3,fontWeight:700,textTransform:'uppercase',letterSpacing:.4};
  async function salvar(){
    if(!form.nome.trim()||!form.valor)return;
    const id=editId||'svc_'+Date.now();
    await setDoc(doc(db,'orc_servicos',id),{nome:form.nome.trim().toUpperCase(),descricao:form.descricao.trim(),valor:parseFloat(String(form.valor).replace(',','.'))||0,criadoEm:new Date().toISOString()});
    setForm({nome:'',descricao:'',valor:''});setEditId(null);setSaved(true);setTimeout(()=>setSaved(false),2000);
  }
  async function remover(id){if(!window.confirm('Remover?'))return;await deleteDoc(doc(db,'orc_servicos',id));}
  async function clonar(s){await setDoc(doc(db,'orc_servicos','svc_'+Date.now()),{...s,nome:s.nome+' (CÓPIA)',criadoEm:new Date().toISOString()});}
  return(
    <div>
      <div style={{fontWeight:700,fontSize:12,color:'#3498db',marginBottom:12,textTransform:'uppercase'}}>Serviços ({servicos.length})</div>
      {servicos.map(s=>(
        <div key={s.id} style={{display:'flex',alignItems:'flex-start',gap:8,padding:'10px 12px',borderRadius:6,background:'#f8f9fa',marginBottom:6,border:'1px solid #e8eaed'}}>
          <div style={{flex:1}}>
            <div style={{fontWeight:700,fontSize:12,color:'#4a4a4a'}}>{s.nome}</div>
            {s.descricao&&<div style={{fontSize:11,color:'#7f8c8d',marginTop:2}}>{s.descricao}</div>}
            <div style={{fontSize:12,fontWeight:700,color:'#27ae60',marginTop:4}}>R$ {Number(s.valor).toFixed(2).replace('.',',')}</div>
          </div>
          <button onClick={()=>{setForm({nome:s.nome,descricao:s.descricao||'',valor:s.valor});setEditId(s.id);}} style={{background:'none',border:'none',cursor:'pointer',color:'#3498db',fontSize:13}}>✏️</button>
          <button onClick={()=>clonar(s)} style={{background:'none',border:'none',cursor:'pointer',color:'#f5a623',fontSize:13}} title="Clonar">⧉</button>
          <button onClick={()=>remover(s.id)} style={{background:'none',border:'none',cursor:'pointer',color:'#e74c3c',fontSize:15}}>×</button>
        </div>
      ))}
      <div style={{background:'#fff',borderRadius:8,padding:'14px',border:'1px dashed #dde1e7',marginTop:8}}>
        <div style={{fontWeight:700,fontSize:11,color:'#4a4a4a',marginBottom:10}}>{editId?'✏️ Editar serviço':'+ Novo serviço'}</div>
        <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:8,marginBottom:8}}>
          <div><label style={lbl}>Nome *</label><input style={{...fi,textTransform:'uppercase'}} value={form.nome} onChange={e=>setForm(x=>({...x,nome:e.target.value.toUpperCase()}))}/></div>
          <div><label style={lbl}>Valor (R$) *</label><input style={fi} type="number" step="0.01" value={form.valor} onChange={e=>setForm(x=>({...x,valor:e.target.value}))}/></div>
        </div>
        <div style={{marginBottom:8}}><label style={lbl}>Descrição</label><textarea style={{...fi,resize:'vertical',minHeight:50}} value={form.descricao} onChange={e=>setForm(x=>({...x,descricao:e.target.value}))}/></div>
        <div style={{display:'flex',gap:8}}>
          <button onClick={salvar} style={{padding:'8px 18px',borderRadius:6,border:'none',background:saved?'#27ae60':'#3498db',color:'#fff',fontWeight:700,cursor:'pointer',fontSize:12}}>{saved?'✓ Salvo!':(editId?'Salvar':'+ Adicionar')}</button>
          {editId&&<button onClick={()=>{setEditId(null);setForm({nome:'',descricao:'',valor:''});}} style={{padding:'8px 14px',borderRadius:6,border:'1px solid #dde1e7',background:'#fff',cursor:'pointer',fontSize:12,color:'#7f8c8d'}}>Cancelar</button>}
        </div>
      </div>
    </div>
  );
}

// --- CONFIG: FORMAS DE PAGAMENTO ----------------------------------------------
function OrcConfigFormas({formas}){
  const [nova,setNova]=useState('');const [saved,setSaved]=useState(false);
  const fi={padding:'8px 10px',borderRadius:5,border:'1px solid #dde1e7',fontSize:13,color:'#4a4a4a',background:'#fff',width:'100%',boxSizing:'border-box'};
  async function add(){if(!nova.trim())return;await setDoc(doc(db,'orc_formas','forma_'+Date.now()),{nome:nova.trim().toUpperCase(),criadoEm:new Date().toISOString()});setNova('');setSaved(true);setTimeout(()=>setSaved(false),2000);}
  async function rem(id){if(!window.confirm('Remover?'))return;await deleteDoc(doc(db,'orc_formas',id));}
  async function clonar(f){await setDoc(doc(db,'orc_formas','forma_'+Date.now()),{...f,nome:f.nome+' (CÓPIA)',criadoEm:new Date().toISOString()});}
  return(
    <div>
      <div style={{fontWeight:700,fontSize:12,color:'#9b59b6',marginBottom:12,textTransform:'uppercase'}}>Formas de pagamento ({formas.length})</div>
      {formas.map(f=>(
        <div key={f.id} style={{display:'flex',alignItems:'center',gap:8,padding:'8px 12px',borderRadius:6,background:'#f8f9fa',marginBottom:6,border:'1px solid #e8eaed'}}>
          <span style={{flex:1,fontSize:12,fontWeight:600,color:'#4a4a4a'}}>{f.nome}</span>
          <button onClick={()=>clonar(f)} style={{background:'none',border:'none',cursor:'pointer',color:'#f5a623',fontSize:12}}>⧉</button>
          <button onClick={()=>rem(f.id)} style={{background:'none',border:'none',cursor:'pointer',color:'#e74c3c',fontSize:14}}>×</button>
        </div>
      ))}
      <div style={{display:'flex',gap:8,marginTop:8}}>
        <input style={{...fi,textTransform:'uppercase'}} value={nova} onChange={e=>setNova(e.target.value.toUpperCase())} placeholder="EX: PIX OU CARTÃO..." onKeyDown={e=>e.key==='Enter'&&add()}/>
        <button onClick={add} style={{padding:'8px 16px',borderRadius:6,border:'none',background:saved?'#27ae60':'#9b59b6',color:'#fff',fontWeight:700,cursor:'pointer',fontSize:12,whiteSpace:'nowrap'}}>{saved?'✓':'+ Add'}</button>
      </div>
    </div>
  );
}

// --- CONFIG: TEMPLATES --------------------------------------------------------
function OrcConfigTemplates({templates}){
  const [sel,setSel]=useState(null);
  const [form,setForm]=useState({nome:'',secoes:[]});
  const [saved,setSaved]=useState(false);
  const fi={padding:'8px 10px',borderRadius:5,border:'1px solid #dde1e7',fontSize:13,color:'#4a4a4a',background:'#fff',width:'100%',boxSizing:'border-box'};
  function nova(){setForm({nome:'NOVA TEMPLATE',secoes:[{id:'s_'+Date.now(),titulo:'SEÇÃO 1',conteudo:''}]});setSel('new');}
  function editar(t){setForm({nome:t.nome,secoes:JSON.parse(JSON.stringify(t.secoes||[]))});setSel(t.id);}
  function addSec(){setForm(f=>({...f,secoes:[...f.secoes,{id:'s_'+Date.now(),titulo:'NOVA SEÇÃO',conteudo:''}]}));}
  function remSec(id){setForm(f=>({...f,secoes:f.secoes.filter(s=>s.id!==id)}));}
  function upSec(id,k,v){setForm(f=>({...f,secoes:f.secoes.map(s=>s.id===id?{...s,[k]:v}:s)}));}
  async function salvar(){
    if(!form.nome.trim())return;
    const id=sel==='new'?'tpl_'+Date.now():sel;
    await setDoc(doc(db,'orc_templates',id),{id,nome:form.nome.trim().toUpperCase(),secoes:form.secoes,atualizadoEm:new Date().toISOString()});
    setSaved(true);setTimeout(()=>setSaved(false),2000);
    if(sel==='new')setSel(id);
  }
  async function remover(id){if(!window.confirm('Remover template?'))return;await deleteDoc(doc(db,'orc_templates',id));if(sel===id)setSel(null);}
  async function clonar(t){const id='tpl_'+Date.now();await setDoc(doc(db,'orc_templates',id),{...t,id,nome:t.nome+' (CÓPIA)',atualizadoEm:new Date().toISOString()});}

  if(sel){
    return(
      <div>
        <button onClick={()=>setSel(null)} style={{background:'none',border:'none',cursor:'pointer',color:'#3498db',fontSize:13,marginBottom:14,display:'flex',alignItems:'center',gap:6,padding:0}}>← Voltar</button>
        <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:14}}>
          <input style={{...fi,fontSize:14,fontWeight:700,flex:1}} value={form.nome} onChange={e=>setForm(f=>({...f,nome:e.target.value.toUpperCase()}))} placeholder="NOME DA TEMPLATE"/>
          <button onClick={salvar} style={{padding:'10px 18px',borderRadius:6,border:'none',background:saved?'#27ae60':'#f5a623',color:'#fff',fontWeight:700,cursor:'pointer',fontSize:12,whiteSpace:'nowrap'}}>{saved?'✓ Salvo!':'💾 Salvar'}</button>
        </div>
        {form.secoes.map(sec=>(
          <div key={sec.id} style={{background:'#fff',borderRadius:8,padding:'12px',marginBottom:10,border:'1px solid #e8eaed'}}>
            <div style={{display:'flex',gap:8,marginBottom:8,alignItems:'center'}}>
              <input style={{...fi,fontWeight:700,fontSize:12}} value={sec.titulo} onChange={e=>upSec(sec.id,'titulo',e.target.value.toUpperCase())} placeholder="TÍTULO DA SEÇÃO"/>
              <button onClick={()=>remSec(sec.id)} style={{background:'none',border:'none',cursor:'pointer',color:'#e74c3c',fontSize:18,flexShrink:0}}>×</button>
            </div>
            <RichEditor value={sec.conteudo} onChange={v=>upSec(sec.id,'conteudo',v)} minHeight={160} placeholder="Cole imagens do Canva aqui (Ctrl+V), adicione textos..."/>
          </div>
        ))}
        <button onClick={addSec} style={{width:'100%',padding:'10px',borderRadius:6,border:'2px dashed #dde1e7',background:'transparent',cursor:'pointer',fontSize:12,color:'#7f8c8d',fontWeight:600,marginTop:4}}>+ Adicionar seção</button>
      </div>
    );
  }
  return(
    <div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
        <div style={{fontWeight:700,fontSize:12,color:'#e74c3c',textTransform:'uppercase'}}>Templates ({templates.length})</div>
        <button onClick={nova} style={{padding:'8px 14px',borderRadius:6,border:'none',background:'#e74c3c',color:'#fff',fontWeight:700,cursor:'pointer',fontSize:12}}>+ Nova template</button>
      </div>
      {templates.length===0&&<div style={{fontSize:12,color:'#7f8c8d',textAlign:'center',padding:'20px',background:'#f8f9fa',borderRadius:8}}>Nenhuma template criada ainda.</div>}
      {templates.map(t=>(
        <div key={t.id} style={{display:'flex',alignItems:'center',gap:10,padding:'12px 14px',borderRadius:8,background:'#f8f9fa',marginBottom:8,border:'1px solid #e8eaed',cursor:'pointer'}} onClick={()=>editar(t)}>
          <div style={{flex:1}}>
            <div style={{fontWeight:700,fontSize:13,color:'#4a4a4a'}}>{t.nome}</div>
            <div style={{fontSize:11,color:'#7f8c8d',marginTop:2}}>{(t.secoes||[]).length} seção(ões)</div>
          </div>
          <button onClick={e=>{e.stopPropagation();clonar(t);}} style={{padding:'4px 10px',borderRadius:5,border:'1px solid #dde1e7',background:'#fff',cursor:'pointer',color:'#f5a623',fontSize:11}}>⧉ Clonar</button>
          <button onClick={e=>{e.stopPropagation();remover(t.id);}} style={{background:'none',border:'none',cursor:'pointer',color:'#e74c3c',fontSize:16}}>×</button>
        </div>
      ))}
    </div>
  );
}

// --- CONFIG ORÇAMENTO (agrupado) ----------------------------------------------
function OrcConfigView({orcServicos,orcFormas,orcTemplates}){
  const [aba,setAba]=useState('servicos');
  const abas=[{id:'servicos',l:'Serviços',c:'#3498db'},{id:'formas',l:'Formas de pagamento',c:'#9b59b6'},{id:'templates',l:'Templates',c:'#e74c3c'}];
  return(
    <div>
      <div style={{display:'flex',gap:6,marginBottom:16,flexWrap:'wrap'}}>
        {abas.map(a=><button key={a.id} onClick={()=>setAba(a.id)} style={{padding:'8px 16px',borderRadius:6,border:'none',background:aba===a.id?a.c:'#ecf0f1',color:aba===a.id?'#fff':'#7f8c8d',cursor:'pointer',fontSize:12,fontWeight:aba===a.id?700:400}}>{a.l}</button>)}
      </div>
      <div style={{background:'#fff',borderRadius:8,padding:'20px',boxShadow:'0 1px 4px rgba(0,0,0,.07)'}}>
        {aba==='servicos'&&<OrcConfigServicos servicos={orcServicos}/>}
        {aba==='formas'&&<OrcConfigFormas formas={orcFormas}/>}
        {aba==='templates'&&<OrcConfigTemplates templates={orcTemplates}/>}
      </div>
    </div>
  );
}

// --- FORMULÁRIO DE ORÇAMENTO --------------------------------------------------
function OrcamentoForm({orcServicos,orcFormas,orcTemplates,equipamentosCad,vendedoresCad,onSalvar,onCancelar,orcEdit}){
  const [etapa,setEtapa]=useState(1);
  const [cli,setCli]=useState(orcEdit?.cliente||{nome:'',empresa:'',cnpj:'',email:'',tel:'',func:'',equipTipo:'',plano:'Basic',nfe:'Não'});
  const [itens,setItens]=useState(orcEdit?.itens||[]);
  const [det,setDet]=useState(orcEdit?.detalhes||{vendedor:'',validade:'',forma:'',obs:'',templateId:'',vE:'',vS:''});
  const [salvando,setSalvando]=useState(false);
  const fi={padding:'8px 10px',borderRadius:5,border:'1px solid #dde1e7',fontSize:13,color:'#4a4a4a',background:'#fff',width:'100%',boxSizing:'border-box'};
  const lbl={fontSize:11,color:'#7f8c8d',display:'block',marginBottom:3,fontWeight:700,textTransform:'uppercase',letterSpacing:.4};

  const subtotal=itens.reduce((s,it)=>{
    const p=parseFloat(it.preco)||0,q=parseFloat(it.qtd)||1,d=parseFloat(it.desconto)||0;
    return s+(p*q-d);
  },0);

  function addItem(tipo,dados){
    setItens(its=>[...its,{id:'i_'+Date.now(),tipo,nome:dados.nome,descricao:dados.descricao||'',preco:dados.valor||dados.preco||0,qtd:1,desconto:0}]);
  }
  function upItem(id,k,v){setItens(its=>its.map(it=>it.id===id?{...it,[k]:v}:it));}
  function remItem(id){setItens(its=>its.filter(it=>it.id!==id));}

  async function salvar(status='rascunho'){
    setSalvando(true);
    const id=orcEdit?.id||'orc_'+Date.now();
    await setDoc(doc(db,'orcamentos',id),{
      id,
      cliente:{...cli},
      itens,
      detalhes:det,
      status,
      subtotal,
      criadoEm:orcEdit?.criadoEm||new Date().toISOString(),
      atualizadoEm:new Date().toISOString()
    });
    setSalvando(false);onSalvar();
  }

  const steps=[{n:1,l:'Cliente'},{n:2,l:'Itens'},{n:3,l:'Detalhes'},{n:4,l:'Preview'}];

  return(
    <div>
      {/* Stepper */}
      <div style={{display:'flex',alignItems:'center',background:'#fff',borderRadius:8,padding:'12px 20px',boxShadow:'0 1px 4px rgba(0,0,0,.07)',marginBottom:16,gap:0}}>
        {steps.map((s,i)=>(
          <React.Fragment key={s.n}>
            <div onClick={()=>setEtapa(s.n)} style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer',flex:1}}>
              <div style={{width:28,height:28,borderRadius:'50%',background:etapa>=s.n?'#f5a623':'#e8eaed',color:etapa>=s.n?'#fff':'#7f8c8d',display:'flex',alignItems:'center',justifyContent:'center',fontSize:12,fontWeight:700,flexShrink:0}}>{etapa>s.n?'✓':s.n}</div>
              <span style={{fontSize:12,fontWeight:etapa===s.n?700:400,color:etapa===s.n?'#f5a623':'#7f8c8d'}}>{s.l}</span>
            </div>
            {i<steps.length-1&&<div style={{flex:0,width:32,height:2,background:etapa>s.n?'#f5a623':'#e8eaed',borderRadius:1,margin:'0 4px'}}/>}
          </React.Fragment>
        ))}
      </div>

      {/* ETAPA 1 */}
      {etapa===1&&(
        <div style={{background:'#fff',borderRadius:8,padding:'20px',boxShadow:'0 1px 4px rgba(0,0,0,.07)'}}>
          <div style={{fontWeight:700,fontSize:12,color:'#4a4a4a',marginBottom:14,textTransform:'uppercase',letterSpacing:.8}}>Dados do cliente</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
            <div><label style={lbl}>Nome do contato *</label><input style={{...fi,textTransform:'uppercase'}} value={cli.nome} onChange={e=>setCli(c=>({...c,nome:e.target.value.toUpperCase()}))}/></div>
            <div><label style={lbl}>Empresa / Razão Social *</label><input style={{...fi,textTransform:'uppercase'}} value={cli.empresa} onChange={e=>setCli(c=>({...c,empresa:e.target.value.toUpperCase()}))}/></div>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
            <div><label style={lbl}>CNPJ / CPF *</label><input style={fi} value={cli.cnpj||''} onChange={e=>setCli(c=>({...c,cnpj:e.target.value.toUpperCase()}))} placeholder="00.000.000/0001-00"/></div>
            <div><label style={lbl}>Email financeiro *</label><input style={fi} type="email" value={cli.email} onChange={e=>setCli(c=>({...c,email:e.target.value}))}/></div>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10,marginBottom:10}}>
            <div><label style={lbl}>Telefone</label><input style={fi} value={cli.tel} onChange={e=>setCli(c=>({...c,tel:mascaraTel(e.target.value)}))}/></div>
            <div><label style={lbl}>Nº Funcionários</label><input style={fi} type="number" value={cli.func||''} onChange={e=>setCli(c=>({...c,func:e.target.value}))}/></div>
            <div><label style={lbl}>Plano</label>
              <select style={fi} value={cli.plano||'Basic'} onChange={e=>setCli(c=>({...c,plano:e.target.value}))}>
                {PLANOS.map(p=><option key={p}>{p}</option>)}
              </select>
            </div>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:14}}>
            <div><label style={lbl}>Equipamento</label>
              <select style={fi} value={cli.equipTipo||''} onChange={e=>setCli(c=>({...c,equipTipo:e.target.value}))}>
                <option value="">— Selecione —</option>
                {(equipamentosCad.length>0?equipamentosCad.map(e=>e.nome):EQUIPS).map(e=><option key={e}>{e}</option>)}
              </select>
            </div>
            <div><label style={lbl}>Emitir NFe?</label>
              <select style={fi} value={cli.nfe||'Não'} onChange={e=>setCli(c=>({...c,nfe:e.target.value}))}>
                <option>Sim</option><option>Não</option>
              </select>
            </div>
          </div>
          <div style={{display:'flex',justifyContent:'flex-end',gap:8}}>
            <button onClick={onCancelar} style={{padding:'10px 18px',borderRadius:7,border:'1px solid #dde1e7',background:'#fff',cursor:'pointer',fontSize:13,color:'#7f8c8d'}}>Cancelar</button>
            <button onClick={()=>setEtapa(2)} disabled={!cli.nome.trim()||!cli.empresa.trim()} style={{padding:'10px 24px',borderRadius:7,border:'none',background:(cli.nome.trim()&&cli.empresa.trim())?'#f5a623':'#e8eaed',color:'#fff',fontWeight:700,cursor:(cli.nome.trim()&&cli.empresa.trim())?'pointer':'default',fontSize:13}}>Próximo →</button>
          </div>
        </div>
      )}

      {/* ETAPA 2 */}
      {etapa===2&&(
        <div>
          <div style={{background:'#fff',borderRadius:8,padding:'20px',boxShadow:'0 1px 4px rgba(0,0,0,.07)',marginBottom:10}}>
            <div style={{fontWeight:700,fontSize:12,color:'#4a4a4a',marginBottom:14,textTransform:'uppercase',letterSpacing:.8}}>Produtos e serviços</div>
            {itens.length===0&&<div style={{fontSize:12,color:'#7f8c8d',textAlign:'center',padding:'14px',background:'#f8f9fa',borderRadius:6,marginBottom:12}}>Nenhum item. Use os painéis abaixo para adicionar.</div>}
            {itens.map((it,idx)=>(
              <div key={it.id} style={{background:'#f8f9fa',borderRadius:8,padding:'12px',marginBottom:10,border:'1px solid #e8eaed'}}>
                <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap',marginBottom:8}}>
                  <div style={{flex:1,fontWeight:700,fontSize:12,color:'#4a4a4a',minWidth:120}}>{it.nome}</div>
                  <div style={{display:'flex',gap:6,alignItems:'flex-end',flexWrap:'wrap'}}>
                    {[['Preço unit. R$','preco',90],['Qtd','qtd',55],['Desconto R$','desconto',90]].map(([l,k,w])=>(
                      <div key={k}>
                        <div style={{fontSize:9,color:'#7f8c8d',textTransform:'uppercase',marginBottom:2}}>{l}</div>
                        <input type="number" min="0" step={k==='qtd'?'1':'0.01'} value={it[k]} onChange={e=>upItem(it.id,k,e.target.value)} style={{width:w,padding:'5px 6px',borderRadius:5,border:'1px solid #dde1e7',fontSize:12,textAlign:'right'}}/>
                      </div>
                    ))}
                    <div>
                      <div style={{fontSize:9,color:'#7f8c8d',textTransform:'uppercase',marginBottom:2}}>Total</div>
                      <div style={{fontSize:13,fontWeight:700,color:'#27ae60',minWidth:90,textAlign:'right'}}>R$ {((parseFloat(it.preco)||0)*(parseFloat(it.qtd)||1)-(parseFloat(it.desconto)||0)).toFixed(2).replace('.',',')}</div>
                    </div>
                    <button onClick={()=>remItem(it.id)} style={{background:'none',border:'none',cursor:'pointer',color:'#e74c3c',fontSize:18}}>×</button>
                  </div>
                </div>
                <RichEditor value={it.descricao} onChange={v=>upItem(it.id,'descricao',v)} minHeight={60} placeholder="Descrição opcional..."/>
              </div>
            ))}
            {itens.length>0&&(
              <div style={{textAlign:'right',padding:'8px 12px',background:'#fff8ee',borderRadius:6,border:'1px solid #fde68a',marginBottom:12}}>
                <span style={{fontSize:13,fontWeight:700,color:'#4a4a4a'}}>Subtotal: </span>
                <span style={{fontSize:15,fontWeight:700,color:'#f5a623'}}>R$ {subtotal.toFixed(2).replace('.',',')}</span>
              </div>
            )}
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
              <div style={{background:'#f0f7ff',borderRadius:8,padding:'12px',border:'1px solid #bee3f8'}}>
                <div style={{fontWeight:700,fontSize:11,color:'#3498db',marginBottom:8,textTransform:'uppercase'}}>+ Serviço</div>
                {orcServicos.length===0&&<div style={{fontSize:11,color:'#7f8c8d'}}>Cadastre em Configurações → Orçamento → Serviços</div>}
                <div style={{maxHeight:150,overflowY:'auto',display:'flex',flexDirection:'column',gap:4}}>
                  {orcServicos.map(s=>(
                    <button key={s.id} onClick={()=>addItem('servico',s)} style={{padding:'7px 10px',borderRadius:5,border:'1px solid #bee3f8',background:'#fff',cursor:'pointer',textAlign:'left',fontSize:11}}>
                      <span style={{fontWeight:600,color:'#4a4a4a'}}>{s.nome}</span>
                      <span style={{color:'#27ae60',marginLeft:8,fontWeight:700}}>R$ {Number(s.valor).toFixed(2).replace('.',',')}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div style={{background:'#f0fff4',borderRadius:8,padding:'12px',border:'1px solid #9ae6b4'}}>
                <div style={{fontWeight:700,fontSize:11,color:'#27ae60',marginBottom:8,textTransform:'uppercase'}}>+ Equipamento</div>
                {equipamentosCad.length===0&&<div style={{fontSize:11,color:'#7f8c8d'}}>Cadastre em Configurações → Equipamentos</div>}
                <div style={{maxHeight:150,overflowY:'auto',display:'flex',flexDirection:'column',gap:4}}>
                  {equipamentosCad.map(e=>(
                    <button key={e.id} onClick={()=>addItem('equipamento',{nome:e.nome,descricao:e.descricao||'',valor:e.preco||1150})} style={{padding:'7px 10px',borderRadius:5,border:'1px solid #9ae6b4',background:'#fff',cursor:'pointer',textAlign:'left',fontSize:11}}>
                      <span style={{fontWeight:600,color:'#4a4a4a'}}>{e.nome}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
          <div style={{display:'flex',justifyContent:'space-between'}}>
            <button onClick={()=>setEtapa(1)} style={{padding:'10px 18px',borderRadius:7,border:'1px solid #dde1e7',background:'#fff',cursor:'pointer',fontSize:13,color:'#7f8c8d'}}>← Voltar</button>
            <button onClick={()=>setEtapa(3)} disabled={itens.length===0} style={{padding:'10px 24px',borderRadius:7,border:'none',background:itens.length>0?'#f5a623':'#e8eaed',color:'#fff',fontWeight:700,cursor:itens.length>0?'pointer':'default',fontSize:13}}>Próximo →</button>
          </div>
        </div>
      )}

      {/* ETAPA 3 */}
      {etapa===3&&(
        <div style={{background:'#fff',borderRadius:8,padding:'20px',boxShadow:'0 1px 4px rgba(0,0,0,.07)'}}>
          <div style={{fontWeight:700,fontSize:12,color:'#4a4a4a',marginBottom:14,textTransform:'uppercase',letterSpacing:.8}}>Detalhes da proposta</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
            <div>
              <label style={lbl}>Vendedor</label>
              {vendedoresCad&&vendedoresCad.length>0
                ?<select style={fi} value={det.vendedor} onChange={e=>setDet(d=>({...d,vendedor:e.target.value}))}>
                    <option value="">— Selecione o vendedor —</option>
                    {vendedoresCad.map(v=><option key={v.id} value={v.nome}>{v.nome}</option>)}
                  </select>
                :<input style={{...fi,textTransform:'uppercase'}} value={det.vendedor} onChange={e=>setDet(d=>({...d,vendedor:e.target.value.toUpperCase()}))} placeholder="Nome do vendedor"/>
              }
            </div>
            <div><label style={lbl}>Validade</label><input style={fi} type="date" value={det.validade} onChange={e=>setDet(d=>({...d,validade:e.target.value}))}/></div>
          </div>
          {/* Valores separados para o Kanban */}
          <div style={{background:'#f0fff4',borderRadius:8,padding:'12px',marginBottom:10,border:'1px solid #9ae6b4'}}>
            <div style={{fontWeight:700,fontSize:11,color:'#276749',marginBottom:8,textTransform:'uppercase'}}>💰 Valores para o Kanban</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
              <div><label style={lbl}>💻 Equipamento (R$)</label><input style={fi} type="number" step="0.01" value={det.vE||''} onChange={e=>setDet(d=>({...d,vE:e.target.value}))} placeholder="0,00"/></div>
              <div><label style={lbl}>🔄 Sistema/mês (R$)</label><input style={fi} type="number" step="0.01" value={det.vS||''} onChange={e=>setDet(d=>({...d,vS:e.target.value}))} placeholder="0,00"/></div>
            </div>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
            <div>
              <label style={lbl}>Forma de pagamento</label>
              <select style={fi} value={det.forma} onChange={e=>setDet(d=>({...d,forma:e.target.value}))}>
                <option value="">— Selecione —</option>
                {orcFormas.map(f=><option key={f.id} value={f.nome}>{f.nome}</option>)}
                <option value="Pix ou Cartão de crédito">Pix ou Cartão de crédito</option>
                <option value="Boleto">Boleto</option>
                <option value="Pix">Pix</option>
              </select>
            </div>
            <div>
              <label style={lbl}>Template</label>
              <select style={fi} value={det.templateId} onChange={e=>setDet(d=>({...d,templateId:e.target.value}))}>
                <option value="">— Sem template —</option>
                {orcTemplates.map(t=><option key={t.id} value={t.id}>{t.nome}</option>)}
              </select>
            </div>
          </div>
          <div style={{marginBottom:10}}>
            <label style={lbl}>Observações / condições</label>
            <textarea style={{...fi,resize:'vertical',minHeight:60}} value={det.obs} onChange={e=>setDet(d=>({...d,obs:e.target.value}))} placeholder="Ex: Frete grátis. Envio após confirmação do pagamento."/>
          </div>
          <div style={{display:'flex',justifyContent:'space-between',marginTop:14}}>
            <button onClick={()=>setEtapa(2)} style={{padding:'10px 18px',borderRadius:7,border:'1px solid #dde1e7',background:'#fff',cursor:'pointer',fontSize:13,color:'#7f8c8d'}}>← Voltar</button>
            <button onClick={()=>setEtapa(4)} style={{padding:'10px 24px',borderRadius:7,border:'none',background:'#f5a623',color:'#fff',fontWeight:700,cursor:'pointer',fontSize:13}}>Preview →</button>
          </div>
        </div>
      )}

      {/* ETAPA 4 — PREVIEW */}
      {etapa===4&&(
        <div>
          <OrcamentoPreview cli={cli} itens={itens} det={det} template={orcTemplates.find(t=>t.id===det.templateId)} subtotal={subtotal}/>
          <div style={{display:'flex',justifyContent:'space-between',marginTop:14,flexWrap:'wrap',gap:8}}>
            <button onClick={()=>setEtapa(3)} style={{padding:'10px 18px',borderRadius:7,border:'1px solid #dde1e7',background:'#fff',cursor:'pointer',fontSize:13,color:'#7f8c8d'}}>← Voltar</button>
            <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
              <button onClick={()=>salvar('rascunho')} style={{padding:'10px 16px',borderRadius:7,border:'1px solid #dde1e7',background:'#fff',cursor:'pointer',fontSize:12,color:'#7f8c8d',fontWeight:600}}>💾 Rascunho</button>
              <button onClick={()=>window.print()} style={{padding:'10px 16px',borderRadius:7,border:'none',background:'#3498db',color:'#fff',fontWeight:700,cursor:'pointer',fontSize:12}}>🖨️ Imprimir/PDF</button>
              <button onClick={()=>{
                const s=encodeURIComponent('Proposta Comercial — Guion Informática');
                const b=encodeURIComponent(`Olá, ${cli.nome}!\n\nSegue a proposta comercial da Guion Informática.\n\nAtenciosamente,\n${det.vendedor||'Guion Informática'}\nfinanceiro@guionstore.com.br`);
                window.open(`mailto:${cli.email}?subject=${s}&body=${b}`);
              }} style={{padding:'10px 16px',borderRadius:7,border:'none',background:'#f5a623',color:'#fff',fontWeight:700,cursor:'pointer',fontSize:12}}>✉️ Email</button>
              <button onClick={()=>salvar('enviado')} disabled={salvando} style={{padding:'10px 16px',borderRadius:7,border:'none',background:'#27ae60',color:'#fff',fontWeight:700,cursor:'pointer',fontSize:12}}>{salvando?'Salvando...':'✅ Salvar como Enviado'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- PREVIEW DA PROPOSTA ------------------------------------------------------
function OrcamentoPreview({cli,itens,det,template,subtotal}){
  const hoje=new Date();
  const validAte=det.validade?new Date(det.validade+'T12:00:00').toLocaleDateString('pt-BR'):'—';
  const descTotal=itens.reduce((s,it)=>s+(parseFloat(it.desconto)||0),0);
  const fmt=v=>'R$ '+v.toFixed(2).replace('.',',');
  return(
    <div id="orc-preview" style={{background:'#fff',border:'1px solid #e8eaed',borderRadius:8,overflow:'hidden',boxShadow:'0 2px 8px rgba(0,0,0,.08)'}}>
      {/* Cabeçalho */}
      <div style={{padding:'20px 28px',borderBottom:'1px solid #e8eaed',display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
        <div>
          <div style={{fontSize:10,color:'#7f8c8d',fontWeight:700,textTransform:'uppercase',letterSpacing:.8,marginBottom:3}}>PROPOSTA</div>
          <div style={{fontWeight:700,fontSize:17,color:'#2c3e50'}}>Guion Informática e Relógio de Ponto</div>
          <div style={{fontSize:11,color:'#7f8c8d'}}>CNPJ: 07.334.645/0001-00</div>
          <div style={{fontSize:11,color:'#7f8c8d',marginTop:2,textTransform:'capitalize'}}>
            {hoje.toLocaleDateString('pt-BR',{weekday:'long',day:'2-digit',month:'2-digit',year:'numeric'})} | Válida até: {validAte}
          </div>
        </div>
        <div style={{textAlign:'right'}}>
          <div style={{fontSize:10,color:'#7f8c8d'}}>Proposta Nº</div>
          <div style={{fontWeight:700,fontSize:12,color:'#2c3e50'}}>orc_{Date.now().toString().slice(-6)}</div>
        </div>
      </div>

      {/* Dados */}
      <div style={{padding:'14px 28px',borderBottom:'1px solid #e8eaed',background:'#fafafa',display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:16}}>
        <div>
          <div style={{fontSize:10,color:'#7f8c8d',fontWeight:700,textTransform:'uppercase',marginBottom:4}}>Proposta enviada por</div>
          <div style={{fontWeight:700,fontSize:12,color:'#2c3e50'}}>{det.vendedor||'ANDREUS CALODIANO'}</div>
          <div style={{fontSize:11,color:'#7f8c8d'}}>✉ andreus@guionstore.com.br</div>
        </div>
        <div>
          <div style={{fontSize:10,color:'#7f8c8d',fontWeight:700,textTransform:'uppercase',marginBottom:4}}>Para</div>
          <div style={{fontWeight:700,fontSize:12,color:'#2c3e50'}}>{cli.empresa||cli.nome}</div>
          {cli.email&&<div style={{fontSize:11,color:'#7f8c8d'}}>✉ {cli.email}</div>}
          {cli.tel&&<div style={{fontSize:11,color:'#7f8c8d'}}>📞 {cli.tel}</div>}
        </div>
        <div>
          <div style={{fontSize:10,color:'#7f8c8d',fontWeight:700,textTransform:'uppercase',marginBottom:4}}>Tipo</div>
          <div style={{fontWeight:700,fontSize:12,color:'#2c3e50'}}>SOFTWARE DE PONTO E EQUIPAMENTO</div>
        </div>
      </div>

      {/* Seções da template */}
      {template&&(template.secoes||[]).map(sec=>(
        <div key={sec.id} style={{borderBottom:'1px solid #e8eaed'}}>
          <div style={{padding:'12px 28px 0',fontWeight:700,fontSize:11,color:'#2c3e50',textTransform:'uppercase',letterSpacing:.8}}>{sec.titulo}</div>
          <div dangerouslySetInnerHTML={{__html:sec.conteudo}} style={{padding:'8px 28px 14px',fontSize:13,color:'#4a4a4a',lineHeight:1.6,overflowX:'auto'}}/>
        </div>
      ))}

      {/* Tabela */}
      <div style={{padding:'18px 28px'}}>
        <div style={{fontWeight:700,fontSize:11,color:'#2c3e50',marginBottom:10,textTransform:'uppercase',letterSpacing:.8}}>Produtos e serviços</div>
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
          <thead>
            <tr style={{background:'#f5f6fa'}}>
              {['Item','Preço unit.','Qtd','Total','Desconto','Total c/ desc.'].map(h=>(
                <th key={h} style={{padding:'7px 10px',textAlign:'left',fontSize:10,color:'#7f8c8d',fontWeight:700,textTransform:'uppercase',letterSpacing:.5,borderBottom:'1px solid #e8eaed'}}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {itens.map((it,i)=>{
              const p=parseFloat(it.preco)||0,q=parseFloat(it.qtd)||1,d=parseFloat(it.desconto)||0;
              return(
                <React.Fragment key={it.id}>
                  <tr style={{borderBottom:it.descricao?'none':'1px solid #f0f0f0',background:i%2===0?'#fff':'#fafafa'}}>
                    <td style={{padding:'9px 10px',fontWeight:700,color:'#2c3e50'}}>{it.nome}</td>
                    <td style={{padding:'9px 10px',color:'#4a4a4a'}}>{fmt(p)}</td>
                    <td style={{padding:'9px 10px',color:'#4a4a4a'}}>{q}</td>
                    <td style={{padding:'9px 10px',color:'#4a4a4a'}}>{fmt(p*q)}</td>
                    <td style={{padding:'9px 10px',color:'#7f8c8d'}}>{fmt(d)}</td>
                    <td style={{padding:'9px 10px',fontWeight:700,color:'#2c3e50'}}>{fmt(p*q-d)}</td>
                  </tr>
                  {it.descricao&&<tr style={{borderBottom:'1px solid #f0f0f0',background:i%2===0?'#fff':'#fafafa'}}>
                    <td colSpan={6} style={{padding:'0 10px 9px'}}>
                      <div dangerouslySetInnerHTML={{__html:it.descricao}} style={{fontSize:11,color:'#7f8c8d'}}/>
                    </td>
                  </tr>}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>

        {/* Totais */}
        <div style={{display:'flex',justifyContent:'flex-end',marginTop:10}}>
          <div style={{minWidth:220}}>
            <div style={{display:'flex',justifyContent:'space-between',padding:'3px 0',fontSize:12,color:'#7f8c8d'}}><span>Valor</span><span>{fmt(subtotal+descTotal)}</span></div>
            <div style={{display:'flex',justifyContent:'space-between',padding:'3px 0',fontSize:12,color:'#7f8c8d'}}><span>Valor do desconto</span><span>- {fmt(descTotal)}</span></div>
            <div style={{display:'flex',justifyContent:'space-between',padding:'8px 0 4px',borderTop:'2px solid #e8eaed',fontWeight:700,fontSize:14,color:'#2c3e50'}}><span>Valor total</span><span>{fmt(subtotal)}</span></div>
          </div>
        </div>

        {/* Pagamento */}
        {(det.validade||det.forma||det.obs)&&(
          <div style={{marginTop:16,padding:'12px',background:'#f8f9fa',borderRadius:6}}>
            <div style={{fontWeight:700,fontSize:11,color:'#2c3e50',marginBottom:6}}>Detalhes e forma de pagamento</div>
            {det.validade&&<div style={{fontSize:11,color:'#7f8c8d'}}>Validade da proposta até {validAte}.</div>}
            {det.forma&&<div style={{fontSize:11,color:'#7f8c8d'}}>Forma de pagamento: {det.forma}.</div>}
            {det.obs&&<div style={{fontSize:11,color:'#7f8c8d',marginTop:3}}>{det.obs}</div>}
          </div>
        )}

        <div style={{marginTop:16,paddingTop:10,borderTop:'1px solid #e8eaed',fontSize:10,color:'#bdc3c7',textAlign:'center'}}>
          Guion Informática e Relógio de Ponto | 07.334.645/0001-00
        </div>
      </div>
    </div>
  );
}

// --- LISTA DE ORÇAMENTOS ------------------------------------------------------
// --- PAINEL LATERAL ORÇAMENTO (fora do OrcamentosView para evitar perda de foco) ---
function PainelLateral({painelOrc,orcamentos,currentUser,nomeVendedor,followInput,setFollowInput,iaResposta,setIaResposta,iaLoading,setIaLoading,iaAberta,setIaAberta,onFechar,onAbrirVenda,onEditar,registrarFollowup,consultarIA,diasDesde,corFollowup,extrairValores}){
  if(!painelOrc)return null;
  const orc=orcamentos.find(o=>o.id===painelOrc.id)||painelOrc;
  const [desc,setDesc]=useState('');
  const [proxData,setProxData]=useState(orc.proximoContato||'');
  const [salvando,setSalvando]=useState(false);
  const dias=diasDesde(orc.criadoEm);
  const diasSemContato=orc.ultimoContato?diasDesde(orc.ultimoContato):dias;
  const corFup=corFollowup(orc);
  const st=STATUS_ORC.find(s=>s.id===orc.status)||STATUS_ORC[0];
  const {vE,vS}=extrairValores(orc);
  const nomeExibido=currentUser?.nome?.split(' ')[0]||nomeVendedor;

  async function salvarFollowup(){
    if(!desc.trim())return;
    setSalvando(true);
    await registrarFollowup(orc,desc,proxData);
    setDesc('');setSalvando(false);
  }

  const fraseAbertura=(()=>{
    if(diasSemContato>=7)return`${nomeExibido}, esse cliente esfriou muito — ${diasSemContato} dias sem contato! Bora reagir ou mover para perdido?`;
    if(!orc.followup?.length)return`${nomeExibido}, esse orçamento ainda não tem nenhum contato registrado. Me conta como foi?`;
    if(orc.proximoContato&&corFup==='#e74c3c')return`${nomeExibido}, o prazo de contato com esse cliente venceu! O que aconteceu?`;
    return`${nomeExibido}, como está esse cliente? Pode me contar e eu te ajudo a fechar! 💪`;
  })();

  return(
    <div style={{position:'fixed',top:0,right:0,width:400,height:'100vh',background:'#fff',boxShadow:'-4px 0 24px rgba(0,0,0,.15)',zIndex:1000,display:'flex',flexDirection:'column',fontFamily:'sans-serif'}}>
      <div style={{background:'#2c3e50',padding:'16px 20px',display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
        <div>
          <div style={{color:'#fff',fontWeight:700,fontSize:14,marginBottom:4}}>{orc.cliente?.empresa||orc.cliente?.nome}</div>
          <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
            <span style={{background:st.color+'33',color:st.color,border:`1px solid ${st.color}`,borderRadius:10,padding:'1px 8px',fontSize:10,fontWeight:700}}>{st.label}</span>
            <span style={{color:'#7f8c8d',fontSize:10}}>⏱ {dias}d no pipeline</span>
            {vE>0&&<span style={{color:'#9ae6b4',fontSize:10}}>💻 {moeda(vE)}</span>}
            {vS>0&&<span style={{color:'#bee3f8',fontSize:10}}>🔄 {moeda(vS)}/mês</span>}
          </div>
        </div>
        <button onClick={onFechar} style={{background:'none',border:'none',color:'#7f8c8d',fontSize:20,cursor:'pointer',lineHeight:1}}>×</button>
      </div>

      <div style={{flex:1,overflowY:'auto',padding:'16px'}}>
        <div style={{background:'#f8f9fa',borderRadius:8,padding:'12px',marginBottom:12,border:`2px solid ${corFup}`}}>
          <div style={{fontSize:11,fontWeight:700,color:corFup,marginBottom:6,textTransform:'uppercase'}}>📅 Próximo contato</div>
          <input type="date" value={proxData} onChange={e=>setProxData(e.target.value)}
            style={{padding:'6px 10px',borderRadius:5,border:'1px solid #dde1e7',fontSize:12,width:'100%',boxSizing:'border-box'}}/>
        </div>

        <div style={{background:'#1a1a2e',borderRadius:8,padding:'12px',marginBottom:12}}>
          <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:8}}>
            <span style={{fontSize:16}}>🤖</span>
            <span style={{color:'#f5a623',fontWeight:700,fontSize:12}}>Co-piloto de Vendas</span>
          </div>
          {!iaAberta&&<div style={{color:'#a0aec0',fontSize:12,marginBottom:8,lineHeight:1.5}}>{fraseAbertura}</div>}
          <textarea
            value={followInput}
            onChange={e=>setFollowInput(e.target.value)}
            placeholder="Conta o que rolou com esse cliente..."
            style={{width:'100%',boxSizing:'border-box',padding:'8px 10px',borderRadius:6,border:'1px solid #2d3748',background:'#2d3748',color:'#e2e8f0',fontSize:12,resize:'vertical',minHeight:70,outline:'none'}}
          />
          <button onClick={()=>consultarIA(orc)} disabled={iaLoading||!followInput.trim()} style={{width:'100%',marginTop:8,padding:'8px',borderRadius:6,border:'none',background:iaLoading?'#4a5568':'#f5a623',color:'#fff',fontWeight:700,cursor:'pointer',fontSize:12}}>
            {iaLoading?'⏳ Analisando...':'✨ Pedir sugestão da IA'}
          </button>
          {iaResposta&&(
            <div style={{marginTop:10,background:'#2d3748',borderRadius:6,padding:'10px',color:'#e2e8f0',fontSize:12,lineHeight:1.6,whiteSpace:'pre-wrap',maxHeight:280,overflowY:'auto'}}>
              {iaResposta}
            </div>
          )}
        </div>

        <div style={{background:'#f8f9fa',borderRadius:8,padding:'12px',marginBottom:12}}>
          <div style={{fontSize:11,fontWeight:700,color:'#2c3e50',marginBottom:8,textTransform:'uppercase'}}>📝 Registrar contato</div>
          <textarea value={desc} onChange={e=>setDesc(e.target.value)} placeholder="O que foi feito/combinado com o cliente?"
            style={{width:'100%',boxSizing:'border-box',padding:'7px 10px',borderRadius:5,border:'1px solid #dde1e7',fontSize:12,resize:'vertical',minHeight:60}}/>
          <button onClick={salvarFollowup} disabled={salvando||!desc.trim()} style={{width:'100%',marginTop:8,padding:'8px',borderRadius:6,border:'none',background:salvando?'#e8eaed':'#3498db',color:'#fff',fontWeight:700,cursor:'pointer',fontSize:12}}>
            {salvando?'Salvando...':'💾 Registrar'}
          </button>
        </div>

        {(orc.followup||[]).length>0&&(
          <div>
            <div style={{fontSize:11,fontWeight:700,color:'#2c3e50',marginBottom:8,textTransform:'uppercase'}}>📋 Histórico de contatos</div>
            {[...(orc.followup||[])].reverse().map((f,i)=>(
              <div key={i} style={{background:'#fff',borderRadius:6,padding:'8px 10px',marginBottom:6,border:'1px solid #e8eaed',borderLeft:'3px solid #3498db'}}>
                <div style={{fontSize:10,color:'#7f8c8d',marginBottom:3}}>{new Date(f.data).toLocaleDateString('pt-BR')} {new Date(f.data).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})} • {f.usuario}</div>
                <div style={{fontSize:12,color:'#2c3e50'}}>{f.descricao}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{padding:'12px 16px',borderTop:'1px solid #e8eaed',display:'flex',gap:8}}>
        {(orc.status==='enviado'||orc.status==='negociacao')&&(
          <button onClick={()=>onAbrirVenda(orc)} style={{flex:1,padding:'10px',borderRadius:6,border:'none',background:'#27ae60',color:'#fff',fontWeight:700,cursor:'pointer',fontSize:12}}>
            🤝 Fechar Venda
          </button>
        )}
        <button onClick={()=>onEditar(orc)} style={{flex:1,padding:'10px',borderRadius:6,border:'1px solid #dde1e7',background:'#fff',cursor:'pointer',fontSize:12,color:'#4a4a4a'}}>
          ✏️ Editar
        </button>
      </div>
    </div>
  );
}

function OrcamentosView({orcamentos,orcServicos,orcFormas,orcTemplates,equipamentosCad,vendedoresCad,onImportarCRM,currentUser}){
  const [subAba,setSubAba]=useState('lista');
  const [visao,setVisao]=useState('lista'); // 'lista' | 'kanban'
  const [orcSel,setOrcSel]=useState(null);
  const [editando,setEditando]=useState(false);
  const [modalVenda,setModalVenda]=useState(null);
  const [dadosVenda,setDadosVenda]=useState({pagamentoI:'Boleto',parcelasI:1,pagamentoE:'Boleto',parcelasE:1,dtBoleto:''});
  const [importando,setImportando]=useState(false);
  const [dragId,setDragId]=useState(null);
  const [dragOver,setDragOver]=useState(null);
  // Painel lateral co-piloto
  const [painelOrc,setPainelOrc]=useState(null);
  const [followInput,setFollowInput]=useState('');
  const [iaResposta,setIaResposta]=useState('');
  const [iaLoading,setIaLoading]=useState(false);
  const [iaAberta,setIaAberta]=useState(false);
  const fi={padding:'7px 10px',borderRadius:5,border:'1px solid #dde1e7',fontSize:12,color:'#4a4a4a',background:'#fff'};
  const nomeVendedor=currentUser?.nome||currentUser?.email?.split('@')[0]||'Vendedor';

  function diasDesde(data){
    if(!data)return 0;
    return Math.floor((Date.now()-new Date(data).getTime())/(1000*60*60*24));
  }
  function corFollowup(orc){
    if(!orc.proximoContato)return'#bdc3c7';
    const diff=Math.floor((new Date(orc.proximoContato).getTime()-Date.now())/(1000*60*60*24));
    if(diff<0)return'#e74c3c';
    if(diff<=1)return'#f5a623';
    return'#27ae60';
  }

  function extrairValores(orc){
    const vE=parseFloat(orc.detalhes?.vE)||0;
    const vS=parseFloat(orc.detalhes?.vS)||0;
    let vI=0;
    (orc.itens||[]).forEach(it=>{
      const n=(it.nome||'').toLowerCase();
      const v=(parseFloat(it.preco)||0)*(parseFloat(it.qtd)||1)-(parseFloat(it.desconto)||0);
      if(n.includes('implanta')||n.includes('instala'))vI+=v;
    });
    return{vI,vE,vS};
  }

  async function atualizarStatus(id,status){
    await setDoc(doc(db,'orcamentos',id),{status,atualizadoEm:new Date().toISOString()},{merge:true});
    if(orcSel?.id===id)setOrcSel(o=>({...o,status}));
  }
  async function remover(id){if(!window.confirm('Remover orçamento?'))return;await deleteDoc(doc(db,'orcamentos',id));setOrcSel(null);}

  function abrirModalVenda(orc){
    setModalVenda(orc);
    setDadosVenda({pagamentoI:'Boleto',parcelasI:1,pagamentoE:'Boleto',parcelasE:1,dtBoleto:''});
  }

  async function confirmarVendaFechada(){
    if(!modalVenda)return;
    setImportando(true);
    const orc=modalVenda;
    const {vI,vE,vS}=extrairValores(orc);
    await setDoc(doc(db,'orcamentos',orc.id),{status:'fechado',atualizadoEm:new Date().toISOString()},{merge:true});
    onImportarCRM({
      nome:(orc.cliente?.empresa||orc.cliente?.nome||'').toUpperCase(),
      cnpj:(orc.cliente?.cnpj||'').toUpperCase(),
      contato:(orc.cliente?.nome||'').toUpperCase(),
      tel:orc.cliente?.tel||'',
      email:orc.cliente?.email||'',
      func:parseInt(orc.cliente?.func)||0,
      equipTipo:orc.cliente?.equipTipo||'Nenhum',
      plano:orc.cliente?.plano||'Basic',
      nfe:orc.cliente?.nfe||'Não',
      vI,vE,vS,total:vI+vE+vS,
      pagamentoI:dadosVenda.pagamentoI,parcelasI:dadosVenda.parcelasI,
      pagamentoE:dadosVenda.pagamentoE,parcelasE:dadosVenda.parcelasE,
      dtBoleto:dadosVenda.dtBoleto,
      vendedor:orc.detalhes?.vendedor||'',
      status:'Aguardando',
      obs:`Importado do orçamento ${orc.id}.`,
      orcamentoId:orc.id,
    });
    setImportando(false);setModalVenda(null);setOrcSel(null);
  }

  // Drag & drop kanban
  async function onDrop(novoStatus){
    if(!dragId)return;
    await setDoc(doc(db,'orcamentos',dragId),{status:novoStatus,atualizadoEm:new Date().toISOString()},{merge:true});
    setDragId(null);setDragOver(null);
  }

  // Registrar follow-up
  async function registrarFollowup(orc,descricao,proximoContato){
    const historico=[...(orc.followup||[]),{
      descricao,data:new Date().toISOString(),
      usuario:nomeVendedor,
    }];
    await setDoc(doc(db,'orcamentos',orc.id),{
      followup:historico,
      proximoContato:proximoContato||orc.proximoContato||'',
      ultimoContato:new Date().toISOString(),
      atualizadoEm:new Date().toISOString(),
    },{merge:true});
    setPainelOrc(o=>({...o,followup:historico,proximoContato:proximoContato||o?.proximoContato}));
  }

  // Co-piloto IA vendas
  async function consultarIA(orc){
    if(!followInput.trim()||!orc)return;
    setIaLoading(true);setIaResposta('');setIaAberta(true);
    const dias=diasDesde(orc.criadoEm);
    const diasSemContato=orc.ultimoContato?diasDesde(orc.ultimoContato):dias;
    const historico=(orc.followup||[]).map(f=>`- ${new Date(f.data).toLocaleDateString('pt-BR')}: ${f.descricao}`).join('\n')||'Nenhum contato registrado ainda.';
    const {vE,vS}=extrairValores(orc);
    try{
      const resposta=await chamadaIA({
        max_tokens:1000,
        system:`Você é um co-piloto de vendas especialista em sistemas de ponto e RH da Secullum. 
Seu papel é ajudar o vendedor ${nomeVendedor} a fechar orçamentos com linguagem direta, persuasiva, profissional mas informal — como um colega sênior experiente.
Use sempre o nome do vendedor (${nomeVendedor}) na sua resposta.
Seja objetivo, prático e motivador. Dê sugestões concretas de abordagem, mensagens prontas para WhatsApp, e estratégias para quebrar objeções.
Nunca seja genérico — use os dados do orçamento para personalizar cada resposta.`,
        messages:[{role:'user',content:`
Orçamento: ${orc.cliente?.empresa||orc.cliente?.nome||'Cliente'}
Valor equipamento: R$ ${vE.toFixed(2)}
Valor sistema/mês: R$ ${vS.toFixed(2)}
Total: R$ ${(orc.subtotal||0).toFixed(2)}
Plano: ${orc.cliente?.plano||'—'}
Status: ${orc.status}
Dias no pipeline: ${dias}
Dias sem contato: ${diasSemContato}
Próximo contato agendado: ${orc.proximoContato?new Date(orc.proximoContato+'T12:00:00').toLocaleDateString('pt-BR'):'Não agendado'}

Histórico de contatos:
${historico}

O vendedor informa: "${followInput}"

Responda como co-piloto de vendas: analise a situação, dê sugestões práticas e, se necessário, gere uma mensagem pronta para WhatsApp.`}],
      });
      setIaResposta(resposta);
    }catch(e){
      setIaResposta(`⚠️ ${e.message}`);
    }
    setIaLoading(false);
  }

  // --- MODAL VENDA FECHADA -------------------------------------------------
  const ModalVendaFechada=()=>{
    if(!modalVenda)return null;
    const orc=modalVenda;
    const {vI,vE,vS}=extrairValores(orc);
    const lbl={fontSize:11,color:'#7f8c8d',display:'block',marginBottom:3,fontWeight:700,textTransform:'uppercase'};
    const upDados=(k,v)=>setDadosVenda(d=>({...d,[k]:v}));
    return(
      <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.5)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}>
        <div style={{background:'#fff',borderRadius:12,padding:'24px',maxWidth:520,width:'100%',boxShadow:'0 20px 60px rgba(0,0,0,.3)',maxHeight:'90vh',overflowY:'auto'}}>
          <div style={{fontWeight:700,fontSize:16,color:'#2c3e50',marginBottom:4}}>🤝 Confirmar Venda Fechada</div>
          <div style={{fontSize:12,color:'#7f8c8d',marginBottom:16}}>Preencha os dados de pagamento para importar ao CRM</div>
          <div style={{background:'#f8f9fa',borderRadius:8,padding:'10px 12px',marginBottom:16}}>
            <div style={{fontWeight:700,fontSize:13,color:'#2c3e50'}}>{orc.cliente?.empresa||orc.cliente?.nome}</div>
            <div style={{fontSize:11,color:'#7f8c8d'}}>{orc.cliente?.cnpj||''} • {orc.cliente?.email}</div>
            <div style={{display:'flex',gap:8,marginTop:8,flexWrap:'wrap'}}>
              {vI>0&&<span style={{background:'#fff8ee',border:'1px solid #fde68a',borderRadius:10,padding:'2px 8px',fontSize:10,fontWeight:700,color:'#b45309'}}>🔧 {moeda(vI)}</span>}
              {vE>0&&<span style={{background:'#f0fff4',border:'1px solid #9ae6b4',borderRadius:10,padding:'2px 8px',fontSize:10,fontWeight:700,color:'#276749'}}>💻 {moeda(vE)}</span>}
              {vS>0&&<span style={{background:'#ebf8ff',border:'1px solid #bee3f8',borderRadius:10,padding:'2px 8px',fontSize:10,fontWeight:700,color:'#2b6cb0'}}>🔄 {moeda(vS)}/mês</span>}
            </div>
          </div>
          {vI>0&&(<div style={{background:'#fff8ee',borderRadius:8,padding:'12px',marginBottom:12,border:'1px solid #fde68a'}}>
            <div style={{fontWeight:700,fontSize:11,color:'#b45309',marginBottom:8}}>🔧 Implantação — {moeda(vI)}</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
              <div><label style={lbl}>Forma</label><select style={fi} value={dadosVenda.pagamentoI} onChange={e=>{upDados('pagamentoI',e.target.value);if(e.target.value==='Pix')upDados('parcelasI',1);}}><option>Boleto</option><option>Pix</option><option value="Cartão">Cartão</option></select></div>
              <div><label style={lbl}>Parcelas</label><select style={fi} value={dadosVenda.parcelasI} onChange={e=>upDados('parcelasI',+e.target.value)} disabled={dadosVenda.pagamentoI==='Pix'}>{[1,2,3].map(n=><option key={n} value={n}>{n}x</option>)}</select></div>
            </div>
          </div>)}
          {vE>0&&(<div style={{background:'#f0fff4',borderRadius:8,padding:'12px',marginBottom:12,border:'1px solid #9ae6b4'}}>
            <div style={{fontWeight:700,fontSize:11,color:'#276749',marginBottom:8}}>💻 Equipamento — {moeda(vE)}</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
              <div><label style={lbl}>Forma</label><select style={fi} value={dadosVenda.pagamentoE} onChange={e=>{upDados('pagamentoE',e.target.value);if(e.target.value==='Pix')upDados('parcelasE',1);}}><option>Boleto</option><option>Pix</option><option value="Cartão">Cartão</option></select></div>
              <div><label style={lbl}>Parcelas</label><select style={fi} value={dadosVenda.parcelasE} onChange={e=>upDados('parcelasE',+e.target.value)} disabled={dadosVenda.pagamentoE==='Pix'}>{[1,2,3,4,5,6,7,8,9,10].map(n=><option key={n} value={n}>{n}x</option>)}</select></div>
            </div>
          </div>)}
          {vS>0&&(<div style={{background:'#ebf8ff',borderRadius:8,padding:'12px',marginBottom:16,border:'1px solid #bee3f8'}}>
            <div style={{fontWeight:700,fontSize:11,color:'#2b6cb0',marginBottom:8}}>🔄 Sistema — {moeda(vS)}/mês</div>
            <div><label style={lbl}>Data vencimento mensal *</label><input style={fi} type="date" value={dadosVenda.dtBoleto} onChange={e=>upDados('dtBoleto',e.target.value)}/></div>
          </div>)}
          <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
            <button onClick={()=>setModalVenda(null)} style={{padding:'10px 20px',borderRadius:7,border:'1px solid #dde1e7',background:'#fff',cursor:'pointer',fontSize:13,color:'#7f8c8d'}}>Cancelar</button>
            <button onClick={confirmarVendaFechada} disabled={importando||(vS>0&&!dadosVenda.dtBoleto)} style={{padding:'10px 24px',borderRadius:7,border:'none',background:'#27ae60',color:'#fff',fontWeight:700,cursor:'pointer',fontSize:13}}>
              {importando?'Importando...':'✅ Confirmar → CRM'}
            </button>
          </div>
        </div>
      </div>
    );
  };

  if(editando&&orcSel){
    return(
      <div>
        <button onClick={()=>setEditando(false)} style={{background:'none',border:'none',cursor:'pointer',color:'#3498db',fontSize:13,marginBottom:14,display:'flex',alignItems:'center',gap:6,padding:0}}>← Voltar</button>
        <OrcamentoForm orcServicos={orcServicos} orcFormas={orcFormas} orcTemplates={orcTemplates} equipamentosCad={equipamentosCad} vendedoresCad={vendedoresCad} orcEdit={orcSel} onSalvar={()=>setEditando(false)} onCancelar={()=>setEditando(false)}/>
      </div>
    );
  }

  if(orcSel&&!painelOrc){
    const orc=orcamentos.find(o=>o.id===orcSel.id)||orcSel;
    const tpl=orcTemplates.find(t=>t.id===orc.detalhes?.templateId);
    return(
      <div>
        {modalVenda&&<ModalVendaFechada/>}
        <button onClick={()=>setOrcSel(null)} style={{background:'none',border:'none',cursor:'pointer',color:'#3498db',fontSize:13,marginBottom:14,display:'flex',alignItems:'center',gap:6,padding:0}}>← Lista de orçamentos</button>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14,flexWrap:'wrap',gap:8}}>
          <div>
            <div style={{fontWeight:700,fontSize:14,color:'#4a4a4a'}}>{orc.cliente?.empresa||orc.cliente?.nome}</div>
            <div style={{fontSize:11,color:'#7f8c8d'}}>{orc.cliente?.email} • {orc.cliente?.tel}</div>
          </div>
          <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
            <select value={orc.status||'rascunho'} onChange={e=>atualizarStatus(orc.id,e.target.value)} style={{...fi,fontWeight:700,color:COR_ORC[orc.status||'rascunho'],borderColor:COR_ORC[orc.status||'rascunho']}}>
              {STATUS_ORC.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
            <button onClick={()=>setEditando(true)} style={{padding:'8px 14px',borderRadius:6,border:'1px solid #dde1e7',background:'#fff',cursor:'pointer',fontSize:12}}>✏️ Editar</button>
            <button onClick={()=>window.print()} style={{padding:'8px 14px',borderRadius:6,border:'none',background:'#3498db',color:'#fff',fontWeight:700,cursor:'pointer',fontSize:12}}>🖨️ Imprimir</button>
            <button onClick={()=>{const s=encodeURIComponent('Proposta Comercial — Guion Informática');const b=encodeURIComponent(`Olá, ${orc.cliente?.nome||''}!\n\nSegue a proposta.\n\nAtenciosamente,\n${orc.detalhes?.vendedor||'Guion Informática'}`);window.open(`mailto:${orc.cliente?.email}?subject=${s}&body=${b}`);}} style={{padding:'8px 14px',borderRadius:6,border:'none',background:'#f5a623',color:'#fff',fontWeight:700,cursor:'pointer',fontSize:12}}>✉️ Email</button>
            {(orc.status==='enviado'||orc.status==='negociacao')&&(
              <button onClick={()=>abrirModalVenda(orc)} style={{padding:'8px 14px',borderRadius:6,border:'none',background:'#27ae60',color:'#fff',fontWeight:700,cursor:'pointer',fontSize:12}}>🤝 Fechar Venda</button>
            )}
            <button onClick={()=>remover(orc.id)} style={{padding:'8px 14px',borderRadius:6,border:'none',background:'#e74c3c',color:'#fff',fontWeight:700,cursor:'pointer',fontSize:12}}>🗑️</button>
          </div>
        </div>
        <OrcamentoPreview cli={orc.cliente||{}} itens={orc.itens||[]} det={orc.detalhes||{}} template={tpl} subtotal={orc.subtotal||0}/>
      </div>
    );
  }

  const porStatus=STATUS_ORC.map(s=>({...s,qtd:orcamentos.filter(o=>o.status===s.id).length,total:orcamentos.filter(o=>o.status===s.id).reduce((acc,o)=>acc+(o.subtotal||0),0)}));

  // --- CARD DO KANBAN -------------------------------------------------------
  const CardKanban=({orc})=>{
    const st=STATUS_ORC.find(s=>s.id===orc.status)||STATUS_ORC[0];
    const dias=diasDesde(orc.criadoEm);
    const diasSemContato=orc.ultimoContato?diasDesde(orc.ultimoContato):dias;
    const corFup=corFollowup(orc);
    const {vE,vS}=extrairValores(orc);
    const alerta=dias>=7;
    const alertaContato=diasSemContato>=5;
    return(
      <div
        draggable
        onDragStart={e=>{setDragId(orc.id);e.dataTransfer.effectAllowed='move';}}
        onDragEnd={()=>{setDragId(null);setDragOver(null);}}
        onClick={()=>{setPainelOrc(orc);setFollowInput('');setIaResposta('');setIaAberta(false);}}
        style={{
          background:'#fff',borderRadius:8,padding:'10px',marginBottom:8,
          cursor:'pointer',boxShadow:'0 1px 4px rgba(0,0,0,.08)',
          borderLeft:`3px solid ${corFup}`,
          opacity:dragId===orc.id?.5:1,
          border:dragId===orc.id?'2px dashed #3498db':'none',
          borderLeft:`3px solid ${corFup}`,
        }}>
        {alerta&&<div style={{background:'#fff5f5',color:'#e74c3c',fontSize:9,fontWeight:700,padding:'2px 6px',borderRadius:4,marginBottom:6,display:'inline-block'}}>⚠ {dias}d sem fechar</div>}
        <div style={{fontSize:12,fontWeight:700,color:'#2c3e50',marginBottom:4,lineHeight:1.3}}>{orc.cliente?.empresa||orc.cliente?.nome||'(sem nome)'}</div>
        <div style={{fontSize:10,color:'#7f8c8d',marginBottom:6}}>{orc.detalhes?.vendedor||'—'} • {orc.criadoEm?new Date(orc.criadoEm).toLocaleDateString('pt-BR'):''}</div>
        <div style={{display:'flex',gap:4,flexWrap:'wrap',marginBottom:6}}>
          {vE>0&&<span style={{background:'#f0fff4',color:'#276749',borderRadius:5,padding:'2px 6px',fontSize:9,fontWeight:700}}>💻 {moeda(vE)}</span>}
          {vS>0&&<span style={{background:'#ebf8ff',color:'#2b6cb0',borderRadius:5,padding:'2px 6px',fontSize:9,fontWeight:700}}>🔄 {moeda(vS)}/mês</span>}
        </div>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <span style={{fontSize:12,fontWeight:700,color:'#27ae60'}}>{moeda(orc.subtotal||0)}</span>
          <div style={{display:'flex',alignItems:'center',gap:4}}>
            {orc.proximoContato&&<span style={{fontSize:9,color:corFup,fontWeight:700}}>📅 {new Date(orc.proximoContato+'T12:00:00').toLocaleDateString('pt-BR')}</span>}
            {alertaContato&&!orc.proximoContato&&<span style={{fontSize:9,color:'#e74c3c',fontWeight:700}}>🔔 {diasSemContato}d s/ contato</span>}
          </div>
        </div>
        {(orc.followup||[]).length>0&&<div style={{fontSize:9,color:'#7f8c8d',marginTop:4}}>💬 {orc.followup.length} contato(s)</div>}
      </div>
    );
  };

  // Extrai valores do orçamento pelos tipos de item
  function extrairValores(orc){
    const itens=orc.itens||[];
    let vI=0,vE=0,vS=0;
    itens.forEach(it=>{
      const n=(it.nome||'').toLowerCase();
      const v=(parseFloat(it.preco)||0)*(parseFloat(it.qtd)||1)-(parseFloat(it.desconto)||0);
      if(it.tipo==='equipamento'||n.includes('evo')||n.includes('tablet')||n.includes('celular')||n.includes('equipamento'))vE+=v;
      else if(n.includes('implanta')||n.includes('instala'))vI+=v;
      else if(n.includes('sistema')||n.includes('mensalidade')||n.includes('saas')||n.includes('/mês')||n.includes('/mes'))vS+=v;
      else if(it.tipo==='servico')vI+=v; // serviços vão para implantação por padrão
    });
    return{vI,vE,vS};
  }

  async function atualizarStatus(id,status){
    await setDoc(doc(db,'orcamentos',id),{status,atualizadoEm:new Date().toISOString()},{merge:true});
    if(orcSel?.id===id)setOrcSel(o=>({...o,status}));
  }
  async function remover(id){if(!window.confirm('Remover orçamento?'))return;await deleteDoc(doc(db,'orcamentos',id));setOrcSel(null);}

  function abrirModalVenda(orc){
    setModalVenda(orc);
    setDadosVenda({pagamentoI:'Boleto',parcelasI:1,pagamentoE:'Boleto',parcelasE:1,dtBoleto:''});
  }

  async function confirmarVendaFechada(){
    if(!modalVenda)return;
    setImportando(true);
    const orc=modalVenda;
    const {vI,vE,vS}=extrairValores(orc);
    // Muda status do orçamento para fechado
    await setDoc(doc(db,'orcamentos',orc.id),{status:'fechado',atualizadoEm:new Date().toISOString()},{merge:true});
    // Importa para o CRM com todos os dados
    onImportarCRM({
      nome:(orc.cliente?.empresa||orc.cliente?.nome||'').toUpperCase(),
      cnpj:(orc.cliente?.cnpj||'').toUpperCase(),
      contato:(orc.cliente?.nome||'').toUpperCase(),
      tel:orc.cliente?.tel||'',
      email:orc.cliente?.email||'',
      func:parseInt(orc.cliente?.func)||0,
      equipTipo:orc.cliente?.equipTipo||'Nenhum',
      plano:orc.cliente?.plano||'Basic',
      nfe:orc.cliente?.nfe||'Não',
      vI,vE,vS,
      total:vI+vE+vS,
      pagamentoI:dadosVenda.pagamentoI,
      parcelasI:dadosVenda.parcelasI,
      pagamentoE:dadosVenda.pagamentoE,
      parcelasE:dadosVenda.parcelasE,
      dtBoleto:dadosVenda.dtBoleto,
      vendedor:orc.detalhes?.vendedor||'',
      status:'Aguardando',
      obs:`Importado do orçamento ${orc.id}. Subtotal: R$ ${(orc.subtotal||0).toFixed(2).replace('.',',')}`,
      orcamentoId:orc.id,
    });
    setImportando(false);
    setModalVenda(null);
    setOrcSel(null);
  }

  return(
    <div>
      {painelOrc&&<PainelLateral
        painelOrc={painelOrc}
        orcamentos={orcamentos}
        currentUser={currentUser}
        nomeVendedor={nomeVendedor}
        followInput={followInput}
        setFollowInput={setFollowInput}
        iaResposta={iaResposta}
        setIaResposta={setIaResposta}
        iaLoading={iaLoading}
        setIaLoading={setIaLoading}
        iaAberta={iaAberta}
        setIaAberta={setIaAberta}
        onFechar={()=>{setPainelOrc(null);setIaResposta('');setIaAberta(false);}}
        onAbrirVenda={abrirModalVenda}
        onEditar={orc=>{setEditando(true);setOrcSel(orc);setPainelOrc(null);}}
        registrarFollowup={registrarFollowup}
        consultarIA={consultarIA}
        diasDesde={diasDesde}
        corFollowup={corFollowup}
        extrairValores={extrairValores}
      />}
      {modalVenda&&<ModalVendaFechada/>}

      {/* Toolbar */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14,flexWrap:'wrap',gap:10}}>
        <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
          {subAba==='lista'&&(
            <>
              <button onClick={()=>setSubAba('novo')} style={{padding:'8px 16px',borderRadius:6,border:'none',background:'#f5a623',color:'#fff',cursor:'pointer',fontSize:12,fontWeight:700}}>+ Novo</button>
              {/* Toggle lista/kanban */}
              <div style={{display:'flex',border:'1px solid #dde1e7',borderRadius:6,overflow:'hidden'}}>
                <button onClick={()=>setVisao('lista')} title="Visão lista" style={{padding:'7px 12px',border:'none',background:visao==='lista'?'#3498db':'#fff',color:visao==='lista'?'#fff':'#7f8c8d',cursor:'pointer'}}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                </button>
                <button onClick={()=>setVisao('kanban')} title="Visão Kanban" style={{padding:'7px 12px',border:'none',background:visao==='kanban'?'#3498db':'#fff',color:visao==='kanban'?'#fff':'#7f8c8d',cursor:'pointer'}}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="5" height="18" rx="1"/><rect x="10" y="3" width="5" height="12" rx="1"/><rect x="17" y="3" width="5" height="15" rx="1"/></svg>
                </button>
              </div>
            </>
          )}
        </div>
        <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
          {porStatus.map(s=><div key={s.id} style={{padding:'3px 10px',borderRadius:20,background:s.color+'22',border:`1px solid ${s.color}`,fontSize:10,fontWeight:700,color:s.color}}>{s.label}: {s.qtd}</div>)}
        </div>
      </div>

      {subAba==='novo'&&<OrcamentoForm orcServicos={orcServicos} orcFormas={orcFormas} orcTemplates={orcTemplates} equipamentosCad={equipamentosCad} vendedoresCad={vendedoresCad} onSalvar={()=>setSubAba('lista')} onCancelar={()=>setSubAba('lista')}/>}

      {subAba==='lista'&&visao==='kanban'&&(
        <div style={{overflowX:'auto',paddingBottom:8}}>
          <div style={{display:'flex',gap:12,minWidth:'max-content'}}>
            {STATUS_ORC.map(st=>{
              const cols=orcamentos.filter(o=>o.status===st.id);
              const total=cols.reduce((s,o)=>s+(o.subtotal||0),0);
              const isOver=dragOver===st.id;
              return(
                <div key={st.id} style={{width:220,flexShrink:0}}
                  onDragOver={e=>{e.preventDefault();setDragOver(st.id);}}
                  onDrop={()=>onDrop(st.id)}
                  onDragLeave={()=>setDragOver(null)}>
                  {/* Cabeçalho coluna */}
                  <div style={{background:st.color,borderRadius:'8px 8px 0 0',padding:'10px 12px'}}>
                    <div style={{color:'#fff',fontWeight:700,fontSize:12}}>{st.label}</div>
                    <div style={{color:'rgba(255,255,255,.8)',fontSize:10,marginTop:2}}>{cols.length} orçamento{cols.length!==1?'s':''}</div>
                    <div style={{color:'#fff',fontSize:13,fontWeight:700,marginTop:4}}>{moeda(total)}</div>
                  </div>
                  {/* Cards */}
                  <div style={{background:isOver?'#d6eaf8':'#f0f2f5',borderRadius:'0 0 8px 8px',minHeight:120,padding:8,border:isOver?`2px dashed ${st.color}`:'2px solid transparent'}}>
                    {cols.map(orc=><CardKanban key={orc.id} orc={orc}/>)}
                    {cols.length===0&&<div style={{fontSize:11,color:'#bdc3c7',textAlign:'center',padding:'20px 0'}}>{isOver?'Soltar aqui':'Vazio'}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {subAba==='lista'&&visao==='lista'&&(
        <div>
          {orcamentos.length===0&&(
            <div style={{background:'#fff',borderRadius:8,padding:'40px',textAlign:'center',boxShadow:'0 1px 4px rgba(0,0,0,.07)'}}>
              <div style={{fontSize:36,marginBottom:10}}>📋</div>
              <div style={{fontWeight:700,fontSize:14,color:'#4a4a4a',marginBottom:6}}>Nenhum orçamento ainda</div>
              <button onClick={()=>setSubAba('novo')} style={{padding:'10px 24px',borderRadius:7,border:'none',background:'#f5a623',color:'#fff',fontWeight:700,cursor:'pointer',fontSize:13}}>+ Novo orçamento</button>
            </div>
          )}
          {[...orcamentos].sort((a,b)=>new Date(b.atualizadoEm||b.criadoEm)-new Date(a.atualizadoEm||a.criadoEm)).map(orc=>{
            const st=STATUS_ORC.find(s=>s.id===orc.status)||STATUS_ORC[0];
            const corFup=corFollowup(orc);
            const dias=diasDesde(orc.criadoEm);
            const {vE,vS}=extrairValores(orc);
            return(
              <div key={orc.id} style={{background:'#fff',borderRadius:8,padding:'13px 16px',marginBottom:8,boxShadow:'0 1px 4px rgba(0,0,0,.06)',display:'flex',alignItems:'center',gap:12,borderLeft:`4px solid ${corFup}`}}>
                <div style={{flex:1,minWidth:0,cursor:'pointer'}} onClick={()=>{setPainelOrc(orc);setFollowInput('');setIaResposta('');setIaAberta(false);}}>
                  <div style={{fontWeight:700,fontSize:13,color:'#4a4a4a',marginBottom:3}}>{orc.cliente?.empresa||orc.cliente?.nome||'(sem nome)'}</div>
                  <div style={{fontSize:11,color:'#7f8c8d',marginBottom:3}}>{orc.detalhes?.vendedor||'—'} • {orc.criadoEm?new Date(orc.criadoEm).toLocaleDateString('pt-BR'):''} • {dias}d no pipeline</div>
                  <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                    {vE>0&&<span style={{background:'#f0fff4',color:'#276749',borderRadius:5,padding:'1px 6px',fontSize:10,fontWeight:700}}>💻 {moeda(vE)}</span>}
                    {vS>0&&<span style={{background:'#ebf8ff',color:'#2b6cb0',borderRadius:5,padding:'1px 6px',fontSize:10,fontWeight:700}}>🔄 {moeda(vS)}/mês</span>}
                  </div>
                </div>
                <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:4,flexShrink:0}}>
                  <div style={{fontWeight:700,fontSize:14,color:'#27ae60'}}>{moeda(orc.subtotal||0)}</div>
                  <span style={{background:st.color+'22',color:st.color,padding:'2px 8px',borderRadius:10,fontSize:10,fontWeight:700}}>{st.label}</span>
                  {orc.proximoContato&&<span style={{fontSize:10,color:corFup,fontWeight:700}}>📅 {new Date(orc.proximoContato+'T12:00:00').toLocaleDateString('pt-BR')}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}  // fim OrcamentosView

// ===========================================================================
// MÓDULO ASAAS — INTEGRAÇÃO FINANCEIRA COMPLETA
// ===========================================================================

// --- PROXIES VIA FIREBASE CLOUD FUNCTIONS ------------------------------------
// Substitui chamadas diretas às APIs (bloqueadas por CORS no browser)
const FUNCTIONS_URL = 'https://us-central1-secullum-crm.cloudfunctions.net';

async function asaasReq(path, method='GET', body=null){
  const resp = await fetch(`${FUNCTIONS_URL}/asaasProxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, method, body }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err?.errors?.[0]?.description || err?.error || `Erro ${resp.status}`);
  }
  return resp.json();
}

async function chamadaIA({ system, messages, max_tokens = 800 }) {
  const resp = await fetch(`${FUNCTIONS_URL}/openaiProxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system, messages, max_tokens }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error || `Erro ${resp.status}`);
  return data.text || '';
}
// --- FIM PROXIES ---

async function asaasBuscarClientePorCNPJ(cnpj){
  const cpfCnpj=(cnpj||'').replace(/\D/g,'');if(!cpfCnpj)return null;
  try{const r=await asaasReq(`/customers?cpfCnpj=${cpfCnpj}`);return r.data?.[0]||null;}catch(e){return null;}
}
async function asaasCriarOuBuscarCliente(c){
  const existente=await asaasBuscarClientePorCNPJ(c.cnpj||'');
  if(existente)return existente;
  return asaasReq('/customers','POST',{
    name:c.nome,
    company:c.empresa||undefined,
    cpfCnpj:(c.cnpj||'').replace(/\D/g,''),
    email:c.email||undefined,
    mobilePhone:(c.tel||'').replace(/\D/g,'')||undefined,
    phone:(c.fone||'').replace(/\D/g,'')||undefined,
    postalCode:(c.cep||'').replace(/\D/g,'')||undefined,
    address:c.rua||undefined,
    addressNumber:c.numero||undefined,
    complement:c.complemento||undefined,
    province:c.bairro||undefined,
    city:c.cidade||undefined,
    municipalInscription:c.inscMunicipal||undefined,
    stateInscription:c.inscEstadual||undefined,
    observations:c.obs||undefined,
    notificationDisabled:false,
  });
}
async function asaasCriarCobranca(customerId,valor,parcelas,billingType,dueDate,desc){
  if(parcelas>1){
    return asaasReq('/payments','POST',{customer:customerId,billingType,totalValue:valor,
      installmentCount:parcelas,installmentValue:+(valor/parcelas).toFixed(2),dueDate,description:desc});
  }
  return asaasReq('/payments','POST',{customer:customerId,billingType,value:valor,dueDate,description:desc});
}
async function asaasCriarAssinatura(customerId,valor,dtBoleto){
  const dia=dtBoleto?new Date(dtBoleto+'T12:00:00').getDate():10;
  const hoje=new Date();
  const prox=new Date(hoje.getFullYear(),hoje.getMonth(),dia);
  if(prox<=hoje)prox.setMonth(prox.getMonth()+1);
  const nd=`${prox.getFullYear()}-${String(prox.getMonth()+1).padStart(2,'0')}-${String(prox.getDate()).padStart(2,'0')}`;
  return asaasReq('/subscriptions','POST',{customer:customerId,billingType:'BOLETO',
    value:valor,nextDueDate:nd,cycle:'MONTHLY',description:'Sistema Secullum — mensalidade'});
}
async function asaasCriarLinkPagamento(customerId,valor,billingType,desc){
  const hoje=new Date();
  const amanha=new Date(hoje);amanha.setDate(hoje.getDate()+1);
  const dueDate=`${amanha.getFullYear()}-${String(amanha.getMonth()+1).padStart(2,'0')}-${String(amanha.getDate()).padStart(2,'0')}`;

  if(billingType==='PIX'){
    const r=await asaasReq('/payments','POST',{
      customer:customerId,billingType:'PIX',value:valor,dueDate,description:desc,
    });
    console.log('[Asaas PIX response]',JSON.stringify(r));
    // invoiceUrl é a URL completa do boleto/pix ex: https://sandbox.asaas.com/i/xxx
    const pixUrl=r.invoiceUrl||r.bankSlipUrl||
      (r.id?`https://sandbox.asaas.com/i/${r.id}`:'');
    return{url:pixUrl,id:r.id||''};
  }

  // Cartão: tenta paymentLinks primeiro
  const r=await asaasReq('/paymentLinks','POST',{
    name:desc,billingType:'CREDIT_CARD',chargeType:'DETACHED',value:valor,description:desc,
  });
  console.log('[Asaas CARTAO response]',JSON.stringify(r));
  const url=r.url||r.shortUrl||r.invoiceUrl||r.paymentUrl||
    (r.id?`https://sandbox.asaas.com/p/${r.id}`:'');
  return{url,id:r.id||''};
}
async function asaasBuscarStatusCliente(customerId){
  try{
    const r=await asaasReq(`/subscriptions?customer=${customerId}&limit=1`);
    const sub=r.data?.[0];
    if(!sub)return'PENDING';
    return sub.status==='ACTIVE'?'RECEIVED':sub.status==='OVERDUE'?'OVERDUE':'PENDING';
  }catch(e){return'PENDING';}
}
// --- FIM API ASAAS ------------------------------------------------------------

// Badge de status Asaas reutilizável
function AsaasBadge({status,size='normal'}){
  const s=ASAAS_STATUS[status]||ASAAS_STATUS.SEM_FATURAMENTO;
  const p=size==='small'?'1px 6px':'2px 10px';
  const fs=size==='small'?9:11;
  return(
    <span style={{background:s.color+'22',color:s.color,border:`1px solid ${s.color}44`,borderRadius:10,padding:p,fontSize:fs,fontWeight:700,whiteSpace:'nowrap'}}>
      {s.emoji} {s.label}
    </span>
  );
}

// Painel financeiro Asaas no detalhe do cliente
function PainelAsaasCliente({cliente,perfil,onUpdate}){
  const [gerandoImpl,setGerandoImpl]=useState(false);
  const [gerandoEquip,setGerandoEquip]=useState(false);
  const [erro,setErro]=useState('');
  // Estado local para refletir links gerados sem depender do pai re-renderizar
  const [linkImpl,setLinkImpl]=useState(cliente.asaas_link_impl||'');
  const [linkEquip,setLinkEquip]=useState(cliente.asaas_link_equip||'');
  const [statusImpl,setStatusImpl]=useState(cliente.asaas_status_impl||'');
  const [statusEquip,setStatusEquip]=useState(cliente.asaas_status_equip||'');

  async function gerarNovoLinkImpl(){
    if(cliente.pagamentoI==='Boleto')return;
    // Bloquear se link ainda válido (não expirado)
    if(linkImpl&&cliente.asaas_link_impl_expira){
      if(new Date(cliente.asaas_link_impl_expira)>new Date()){return;}
    }
    setGerandoImpl(true);setErro('');
    try{
      let asaasId=cliente.asaas_id;
      if(!asaasId){const ac=await asaasCriarOuBuscarCliente(cliente);asaasId=ac.id;}
      const billingType=cliente.pagamentoI==='Pix'?'PIX':'CREDIT_CARD';
      const link=await asaasCriarLinkPagamento(asaasId,parseFloat(cliente.vI)||0,billingType,`Implantação — ${cliente.nome}`);
      const url=link.url||'';
      // Expira em 48h (dueDate amanhã + 24h tolerância)
      const expira=new Date();expira.setHours(expira.getHours()+48);
      setLinkImpl(url);setStatusImpl('PENDING');
      await onUpdate({...cliente,asaas_id:asaasId,
        asaas_link_impl:url,asaas_link_impl_id:link.id||'',
        asaas_link_impl_expira:expira.toISOString(),
        asaas_status_impl:'PENDING',
        status:'Links enviados',
      });
    }catch(e){setErro('Erro ao gerar link: '+e.message);}
    setGerandoImpl(false);
  }

  async function gerarNovoLinkEquip(){
    if(cliente.pagamentoE==='Boleto')return;
    if(linkEquip&&cliente.asaas_link_equip_expira){
      if(new Date(cliente.asaas_link_equip_expira)>new Date())return;
    }
    setGerandoEquip(true);setErro('');
    try{
      let asaasId=cliente.asaas_id;
      if(!asaasId){const ac=await asaasCriarOuBuscarCliente(cliente);asaasId=ac.id;}
      const billingType=cliente.pagamentoE==='Pix'?'PIX':'CREDIT_CARD';
      const link=await asaasCriarLinkPagamento(asaasId,parseFloat(cliente.vE)||0,billingType,`Equipamento — ${cliente.nome}`);
      const url=link.url||'';
      const expira=new Date();expira.setHours(expira.getHours()+48);
      setLinkEquip(url);setStatusEquip('PENDING');
      await onUpdate({...cliente,asaas_id:asaasId,
        asaas_link_equip:url,asaas_link_equip_id:link.id||'',
        asaas_link_equip_expira:expira.toISOString(),
        asaas_status_equip:'PENDING',
        status:'Links enviados',
      });
    }catch(e){setErro('Erro ao gerar link: '+e.message);}
    setGerandoEquip(false);
  }

  function LinkBox({label,link,tipo,status,waMsg,onGerarNovo,gerando,cor,corBg,expira}){
    const temLink=!!(link&&link.length>0);
    const expirado=expira?new Date(expira)<new Date():false;
    const horasRestantes=expira&&!expirado?Math.round((new Date(expira)-new Date())/3600000):0;
    return(
      <div style={{padding:'10px',background:corBg,borderRadius:6,border:`1px solid ${cor}44`,marginBottom:8}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
          <span style={{fontSize:10,color:cor,fontWeight:700,textTransform:'uppercase'}}>{label}</span>
          <div style={{display:'flex',gap:6,alignItems:'center'}}>
            {temLink&&!expirado&&horasRestantes>0&&<span style={{fontSize:9,color:'#7f8c8d'}}>⏰ {horasRestantes}h restantes</span>}
            {expirado&&<span style={{fontSize:9,color:'#e74c3c',fontWeight:700}}>⚠ Expirado</span>}
            <AsaasBadge status={status||'PENDING'} size="small"/>
          </div>
        </div>
        {temLink?(
          <>
            {/* QR Code visual via API pública */}
            {tipo==='Pix'&&(
              <div style={{textAlign:'center',marginBottom:8}}>
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(link)}`}
                  alt="QR Code Pix"
                  style={{borderRadius:6,border:'1px solid #dde1e7',padding:4,background:'#fff'}}
                />
              </div>
            )}
            <div style={{background:'#fff',borderRadius:5,padding:'6px 8px',fontSize:10,color:'#4a4a4a',wordBreak:'break-all',marginBottom:6,border:'1px solid #e8eaed',maxHeight:40,overflow:'hidden',textOverflow:'ellipsis'}}>
              {link}
            </div>
            <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
              <button onClick={()=>navigator.clipboard.writeText(link)} style={{padding:'5px 10px',borderRadius:5,border:`1px solid ${cor}`,background:'#fff',cursor:'pointer',fontSize:10,fontWeight:700,color:cor}}>📋 Copiar</button>
              <a href={`https://wa.me/${telParaWa(cliente.tel||'')}?text=${encodeURIComponent(waMsg+' '+link)}`} target="_blank" rel="noopener noreferrer" style={{padding:'5px 10px',borderRadius:5,border:'1px solid #25D366',background:'#fff',cursor:'pointer',fontSize:10,fontWeight:700,color:'#25D366',textDecoration:'none'}}>📲 WhatsApp</a>
              {(expirado||!expira)&&(
                <button onClick={onGerarNovo} disabled={gerando} style={{padding:'5px 10px',borderRadius:5,border:'1px solid #7f8c8d',background:'#fff',cursor:'pointer',fontSize:10,fontWeight:700,color:'#7f8c8d'}}>
                  {gerando?'⏳':'🔄 Novo link'}
                </button>
              )}
            </div>
          </>
        ):(
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
            <span style={{fontSize:11,color:'#7f8c8d'}}>{tipo==='Boleto'?'📄 Financeiro processa':'Sem link gerado'}</span>
            {tipo!=='Boleto'&&(
              <button onClick={onGerarNovo} disabled={gerando} style={{padding:'5px 12px',borderRadius:5,border:'none',background:cor,color:'#fff',cursor:'pointer',fontSize:10,fontWeight:700}}>
                {gerando?'⏳ Gerando...':'⚡ Gerar link'}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return(
    <div style={{background:'#fff',borderRadius:8,border:'1px solid #e8eaed',overflow:'hidden'}}>
      <div style={{background:'#f8f9fa',padding:'10px 14px',borderBottom:'1px solid #e8eaed',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <span style={{fontWeight:700,fontSize:11,color:'#2c3e50',textTransform:'uppercase'}}>💰 Pagamentos</span>
        {cliente.asaas_id&&<span style={{fontSize:9,color:'#bdc3c7'}}>Asaas ID: {cliente.asaas_id}</span>}
      </div>
      <div style={{padding:'12px 14px'}}>
        {erro&&<div style={{background:'#fff5f5',borderRadius:6,padding:'8px',marginBottom:8,fontSize:11,color:'#e74c3c'}}>{erro}</div>}

        {/* Implantação */}
        {parseFloat(cliente.vI)>0&&(
          <LinkBox
            label={`🔧 Implantação — ${moeda(parseFloat(cliente.vI))} • ${cliente.parcelasI||1}x`}
            link={linkImpl}
            tipo={cliente.pagamentoI||'Boleto'}
            status={statusImpl||'PENDING'}
            waMsg="Olá! Segue o link para pagamento da implantação:"
            onGerarNovo={gerarNovoLinkImpl}
            gerando={gerandoImpl}
            cor="#b45309"
            corBg="#fff8ee"
            expira={cliente.asaas_link_impl_expira}
          />
        )}

        {/* Equipamento */}
        {parseFloat(cliente.vE)>0&&(
          <LinkBox
            label={`💻 Equipamento — ${moeda(parseFloat(cliente.vE))} • ${cliente.parcelasE||1}x`}
            link={linkEquip}
            tipo={cliente.pagamentoE||'Boleto'}
            status={statusEquip||'PENDING'}
            waMsg="Olá! Segue o link para pagamento do equipamento:"
            onGerarNovo={gerarNovoLinkEquip}
            gerando={gerandoEquip}
            cor="#276749"
            corBg="#f0fff4"
            expira={cliente.asaas_link_equip_expira}
          />
        )}

        {/* Sistema */}
        {parseFloat(cliente.vS)>0&&(
          <div style={{padding:'10px',background:'#ebf8ff',borderRadius:6,border:'1px solid #bee3f844'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
              <span style={{fontSize:10,color:'#2b6cb0',fontWeight:700,textTransform:'uppercase'}}>🔄 Sistema — {moeda(parseFloat(cliente.vS))}/mês</span>
              <AsaasBadge status={cliente.asaas_status_sistema||'SEM_FATURAMENTO'} size="small"/>
            </div>
            <div style={{fontSize:11,color:'#7f8c8d'}}>
              {cliente.asaas_id?`Vence dia ${cliente.dtBoleto?new Date(cliente.dtBoleto+'T12:00:00').getDate():'—'} todo mês`:'📄 Financeiro processa ao gerar faturamento'}
            </div>
            {cliente.asaas_ultimo_pagamento&&<div style={{fontSize:10,color:'#7f8c8d',marginTop:2}}>Último pag.: {new Date(cliente.asaas_ultimo_pagamento).toLocaleDateString('pt-BR')}</div>}
          </div>
        )}

        {!parseFloat(cliente.vI)&&!parseFloat(cliente.vE)&&!parseFloat(cliente.vS)&&(
          <div style={{textAlign:'center',padding:'16px',color:'#bdc3c7',fontSize:12}}>Nenhum valor cadastrado</div>
        )}
      </div>
    </div>
  );
}

// Modal Gerar Faturamento (financeiro)
function ModalGerarFaturamento({cliente,onConfirmar,onCancelar}){
  const [checks,setChecks]=useState({impl:cliente.vI>0&&cliente.pagamentoI==='Boleto',equip:cliente.vE>0&&cliente.pagamentoE==='Boleto',sistema:cliente.vS>0});
  const [loading,setLoading]=useState(false);
  const toggleCheck=k=>setChecks(c=>({...c,[k]:!c[k]}));
  const temAlgo=checks.impl||checks.equip||checks.sistema;

  async function confirmar(){
    setLoading(true);
    await onConfirmar(checks);
    setLoading(false);
  }

  return(
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.55)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}>
      <div style={{background:'#fff',borderRadius:12,padding:'24px',maxWidth:480,width:'100%',boxShadow:'0 20px 60px rgba(0,0,0,.3)'}}>
        <div style={{fontWeight:700,fontSize:16,color:'#2c3e50',marginBottom:4}}>🚀 Gerar Faturamento</div>
        <div style={{fontSize:12,color:'#7f8c8d',marginBottom:16}}>Selecione as cobranças para processar no Asaas</div>

        {/* Resumo cliente */}
        <div style={{background:'#f8f9fa',borderRadius:8,padding:'10px 12px',marginBottom:16}}>
          <div style={{fontWeight:700,fontSize:13,color:'#2c3e50'}}>{cliente.nome}</div>
          <div style={{fontSize:11,color:'#7f8c8d'}}>{cliente.cnpj}</div>
        </div>

        {/* Checkboxes */}
        <div style={{display:'flex',flexDirection:'column',gap:10,marginBottom:20}}>
          {cliente.vI>0&&cliente.pagamentoI==='Boleto'&&(
            <label style={{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',borderRadius:8,border:`2px solid ${checks.impl?'#f5a623':'#e8eaed'}`,cursor:'pointer',background:checks.impl?'#fff8ee':'#fff'}}>
              <input type="checkbox" checked={checks.impl} onChange={()=>toggleCheck('impl')} style={{width:16,height:16}}/>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:12,color:'#b45309'}}>🔧 Implantação</div>
                <div style={{fontSize:11,color:'#7f8c8d'}}>{moeda(cliente.vI)} • Boleto {cliente.parcelasI||1}x</div>
              </div>
            </label>
          )}
          {cliente.vE>0&&cliente.pagamentoE==='Boleto'&&(
            <label style={{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',borderRadius:8,border:`2px solid ${checks.equip?'#27ae60':'#e8eaed'}`,cursor:'pointer',background:checks.equip?'#f0fff4':'#fff'}}>
              <input type="checkbox" checked={checks.equip} onChange={()=>toggleCheck('equip')} style={{width:16,height:16}}/>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:12,color:'#276749'}}>💻 Equipamento</div>
                <div style={{fontSize:11,color:'#7f8c8d'}}>{moeda(cliente.vE)} • Boleto {cliente.parcelasE||1}x</div>
              </div>
            </label>
          )}
          {cliente.vS>0&&(
            <label style={{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',borderRadius:8,border:`2px solid ${checks.sistema?'#3498db':'#e8eaed'}`,cursor:'pointer',background:checks.sistema?'#ebf8ff':'#fff'}}>
              <input type="checkbox" checked={checks.sistema} onChange={()=>toggleCheck('sistema')} style={{width:16,height:16}}/>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:12,color:'#2b6cb0'}}>🔄 Sistema SaaS recorrente</div>
                <div style={{fontSize:11,color:'#7f8c8d'}}>{moeda(cliente.vS)}/mês • vence dia {cliente.dtBoleto?new Date(cliente.dtBoleto+'T12:00:00').getDate():'—'}</div>
              </div>
            </label>
          )}
          {/* Links já gerados pelo vendedor (info) */}
          {cliente.vI>0&&cliente.pagamentoI!=='Boleto'&&(
            <div style={{padding:'10px 14px',borderRadius:8,border:'1px solid #dde1e7',background:'#f8f9fa',display:'flex',alignItems:'center',gap:8}}>
              <span style={{fontSize:16}}>{cliente.asaas_link_impl?'✅':'⚡'}</span>
              <div>
                <div style={{fontWeight:700,fontSize:11,color:'#4a4a4a'}}>🔧 Implantação — {cliente.pagamentoI}</div>
                <div style={{fontSize:10,color:'#7f8c8d'}}>{cliente.asaas_link_impl?'Link gerado pelo vendedor ✅':'Aguardando vendedor gerar link'}</div>
              </div>
            </div>
          )}
          {cliente.vE>0&&cliente.pagamentoE!=='Boleto'&&(
            <div style={{padding:'10px 14px',borderRadius:8,border:'1px solid #dde1e7',background:'#f8f9fa',display:'flex',alignItems:'center',gap:8}}>
              <span style={{fontSize:16}}>{cliente.asaas_link_equip?'✅':'⚡'}</span>
              <div>
                <div style={{fontWeight:700,fontSize:11,color:'#4a4a4a'}}>💻 Equipamento — {cliente.pagamentoE}</div>
                <div style={{fontSize:10,color:'#7f8c8d'}}>{cliente.asaas_link_equip?'Link gerado pelo vendedor ✅':'Aguardando vendedor gerar link'}</div>
              </div>
            </div>
          )}
        </div>

        <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
          <button onClick={onCancelar} style={{padding:'10px 20px',borderRadius:7,border:'1px solid #dde1e7',background:'#fff',cursor:'pointer',fontSize:13,color:'#7f8c8d'}}>Cancelar</button>
          <button onClick={confirmar} disabled={!temAlgo||loading} style={{padding:'10px 24px',borderRadius:7,border:'none',background:(!temAlgo||loading)?'#e8eaed':'#27ae60',color:'#fff',fontWeight:700,cursor:(!temAlgo||loading)?'default':'pointer',fontSize:13}}>
            {loading?'Processando no Asaas...':'✅ Confirmar e Faturar'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Modal Edição/Cancelamento com senha e motivo
function ModalConfirmacaoFinanceira({tipo,cliente,onConfirmar,onCancelar}){
  const [quem,setQuem]=useState('');
  const [motivo,setMotivo]=useState('');
  const [senha,setSenha]=useState('');
  const [erro,setErro]=useState('');
  const [loading,setLoading]=useState(false);
  const fi={padding:'8px 10px',borderRadius:5,border:'1px solid #dde1e7',fontSize:13,color:'#2c3e50',background:'#fff',width:'100%',boxSizing:'border-box'};
  const lbl={fontSize:11,color:'#7f8c8d',display:'block',marginBottom:3,fontWeight:700,textTransform:'uppercase'};

  const isCancelamento=tipo==='cancelamento';
  const corTitulo=isCancelamento?'#e74c3c':'#f5a623';
  const emoji=isCancelamento?'❌':'✏️';
  const titulo=isCancelamento?'Cancelar Assinatura':'Alterar dados financeiros';

  async function confirmar(){
    if(!quem.trim()||!motivo.trim()||!senha.trim()){setErro('Preencha todos os campos');return;}
    setErro('');setLoading(true);
    try{
      const cred=await import('firebase/auth').then(m=>m.EmailAuthProvider.credential(auth.currentUser.email,senha));
      await import('firebase/auth').then(m=>m.reauthenticateWithCredential(auth.currentUser,cred));
      await onConfirmar({quem,motivo});
    }catch(e){
      setErro('Senha incorreta. Tente novamente.');
    }finally{setLoading(false);}
  }

  return(
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.55)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}>
      <div style={{background:'#fff',borderRadius:12,padding:'24px',maxWidth:440,width:'100%',boxShadow:'0 20px 60px rgba(0,0,0,.3)'}}>
        <div style={{fontWeight:700,fontSize:16,color:corTitulo,marginBottom:4}}>{emoji} {titulo}</div>
        <div style={{background:'#f8f9fa',borderRadius:8,padding:'8px 12px',marginBottom:16,fontSize:12,color:'#7f8c8d'}}>{cliente.nome}</div>
        {isCancelamento&&(
          <div style={{background:'#fff5f5',border:'1px solid #feb2b2',borderRadius:8,padding:'10px 14px',marginBottom:16,fontSize:12,color:'#c53030'}}>
            ⚠️ Esta ação irá cancelar a recorrência mensal no Asaas. O cliente deixará de receber boletos.
          </div>
        )}
        <div style={{display:'flex',flexDirection:'column',gap:10,marginBottom:16}}>
          <div><label style={lbl}>Quem solicitou (contato do cliente) *</label><input style={fi} value={quem} onChange={e=>setQuem(e.target.value)} placeholder="Ex: Maria — Financeiro"/></div>
          <div><label style={lbl}>Motivo *</label><textarea style={{...fi,resize:'vertical',minHeight:60}} value={motivo} onChange={e=>setMotivo(e.target.value)} placeholder="Descreva o motivo da alteração..."/></div>
          <div><label style={lbl}>Sua senha de acesso *</label><input style={fi} type="password" value={senha} onChange={e=>setSenha(e.target.value)} placeholder="Digite sua senha para confirmar"/></div>
        </div>
        {erro&&<div style={{background:'#fff5f5',border:'1px solid #feb2b2',borderRadius:6,padding:'8px 12px',fontSize:12,color:'#c53030',marginBottom:12}}>{erro}</div>}
        <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
          <button onClick={onCancelar} style={{padding:'10px 20px',borderRadius:7,border:'1px solid #dde1e7',background:'#fff',cursor:'pointer',fontSize:13,color:'#7f8c8d'}}>Cancelar</button>
          <button onClick={confirmar} disabled={loading} style={{padding:'10px 24px',borderRadius:7,border:'none',background:loading?'#e8eaed':isCancelamento?'#e74c3c':'#f5a623',color:'#fff',fontWeight:700,cursor:'pointer',fontSize:13}}>
            {loading?'Aguarde...':isCancelamento?'Confirmar Cancelamento':'Confirmar Alteração'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Dashboard Asaas completo
function AsaasView({todos,clientes,perfil,onAtualizarCliente}){
  const [subAba,setSubAba]=useState('dashboard');
  const [filtroStatus,setFiltroStatus]=useState('Todos');

  // Clientes com Asaas vinculado (novos)
  const comAsaas=clientes.filter(c=>c.asaas_id);
  const semAsaas=clientes.filter(c=>!c.asaas_id&&!c._base);
  const emDia=comAsaas.filter(c=>c.asaas_status==='RECEIVED'||c.asaas_status==='CONFIRMED');
  const pendentes=comAsaas.filter(c=>c.asaas_status==='PENDING');
  const vencidos=comAsaas.filter(c=>c.asaas_status==='OVERDUE');
  const cancelados=comAsaas.filter(c=>c.asaas_status==='CANCELED');
  const mrr=emDia.reduce((s,c)=>s+(c.vS||0),0)+pendentes.reduce((s,c)=>s+(c.vS||0),0);
  const recebidoMes=emDia.reduce((s,c)=>s+(c.vS||0),0);
  const inadimplencia=vencidos.reduce((s,c)=>s+(c.vS||0),0);

  const listaFiltrada=()=>{
    if(filtroStatus==='OVERDUE')return vencidos;
    if(filtroStatus==='PENDING')return pendentes;
    if(filtroStatus==='RECEIVED')return emDia;
    if(filtroStatus==='CANCELED')return cancelados;
    if(filtroStatus==='SEM_FATURAMENTO')return semAsaas;
    return comAsaas;
  };

  const subAbas=[
    {id:'dashboard',l:'📊 Dashboard'},
    {id:'cobrancas',l:'📋 Cobranças'},
    {id:'assinaturas',l:`🔄 Assinaturas (${comAsaas.length})`},
    {id:'inadimplentes',l:`🔴 Inadimplentes (${vencidos.length})`},
    {id:'relatorios',l:'📈 Relatórios'},
  ];

  return(
    <div>
      <div style={{display:'flex',gap:6,marginBottom:16,flexWrap:'wrap'}}>
        {subAbas.map(s=>(
          <button key={s.id} onClick={()=>setSubAba(s.id)} style={{padding:'8px 14px',borderRadius:6,border:'none',background:subAba===s.id?'#27ae60':'#ecf0f1',color:subAba===s.id?'#fff':'#7f8c8d',cursor:'pointer',fontSize:12,fontWeight:subAba===s.id?700:400}}>{s.l}</button>
        ))}
      </div>

      {/* DASHBOARD */}
      {subAba==='dashboard'&&(
        <div>
          {/* Cards de topo */}
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(160px,1fr))',gap:12,marginBottom:20}}>
            <div style={{background:'#fff',borderRadius:8,padding:'16px',boxShadow:'0 1px 4px rgba(0,0,0,.07)',borderTop:'3px solid #27ae60'}}>
              <div style={{fontSize:10,color:'#7f8c8d',textTransform:'uppercase',fontWeight:700,marginBottom:6}}>💚 Recebido este mês</div>
              <div style={{fontSize:22,fontWeight:700,color:'#27ae60'}}>{moeda(recebidoMes)}</div>
              <div style={{fontSize:10,color:'#7f8c8d',marginTop:4}}>{emDia.length} assinaturas em dia</div>
            </div>
            <div style={{background:'#fff',borderRadius:8,padding:'16px',boxShadow:'0 1px 4px rgba(0,0,0,.07)',borderTop:'3px solid #f5a623'}}>
              <div style={{fontSize:10,color:'#7f8c8d',textTransform:'uppercase',fontWeight:700,marginBottom:6}}>⏳ Pendente</div>
              <div style={{fontSize:22,fontWeight:700,color:'#f5a623'}}>{moeda(pendentes.reduce((s,c)=>s+(c.vS||0),0))}</div>
              <div style={{fontSize:10,color:'#7f8c8d',marginTop:4}}>{pendentes.length} aguardando pagamento</div>
            </div>
            <div style={{background:'#fff',borderRadius:8,padding:'16px',boxShadow:'0 1px 4px rgba(0,0,0,.07)',borderTop:'3px solid #e74c3c'}}>
              <div style={{fontSize:10,color:'#7f8c8d',textTransform:'uppercase',fontWeight:700,marginBottom:6}}>🔴 Inadimplentes</div>
              <div style={{fontSize:22,fontWeight:700,color:'#e74c3c'}}>{moeda(inadimplencia)}</div>
              <div style={{fontSize:10,color:'#7f8c8d',marginTop:4}}>{vencidos.length} em atraso</div>
            </div>
            <div style={{background:'#fff',borderRadius:8,padding:'16px',boxShadow:'0 1px 4px rgba(0,0,0,.07)',borderTop:'3px solid #3498db'}}>
              <div style={{fontSize:10,color:'#7f8c8d',textTransform:'uppercase',fontWeight:700,marginBottom:6}}>📈 MRR total</div>
              <div style={{fontSize:22,fontWeight:700,color:'#3498db'}}>{moeda(mrr)}</div>
              <div style={{fontSize:10,color:'#7f8c8d',marginTop:4}}>{comAsaas.length} assinaturas ativas</div>
            </div>
          </div>

          {/* Gráfico de barras MRR (visual) */}
          <div style={{background:'#fff',borderRadius:8,padding:'16px',boxShadow:'0 1px 4px rgba(0,0,0,.07)',marginBottom:16}}>
            <div style={{fontWeight:700,fontSize:12,color:'#2c3e50',marginBottom:12,textTransform:'uppercase'}}>Distribuição de assinaturas</div>
            <div style={{display:'flex',gap:6,alignItems:'flex-end',height:80}}>
              {[
                {l:'Em dia',v:emDia.length,c:'#27ae60'},
                {l:'Pendente',v:pendentes.length,c:'#f5a623'},
                {l:'Vencido',v:vencidos.length,c:'#e74c3c'},
                {l:'Cancelado',v:cancelados.length,c:'#7f8c8d'},
                {l:'Sem fat.',v:semAsaas.length,c:'#3498db'},
              ].map((d,i)=>{
                const max=Math.max(emDia.length,pendentes.length,vencidos.length,cancelados.length,semAsaas.length,1);
                return(
                  <div key={i} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:4}}>
                    <div style={{fontSize:11,fontWeight:700,color:d.c}}>{d.v}</div>
                    <div style={{width:'100%',background:d.c,borderRadius:'4px 4px 0 0',height:`${Math.max((d.v/max)*60,d.v>0?4:0)}px`}}/>
                    <div style={{fontSize:9,color:'#7f8c8d',textAlign:'center',lineHeight:1.2}}>{d.l}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Clientes aguardando faturamento */}
          {semAsaas.length>0&&(
            <div style={{background:'#fff',borderRadius:8,padding:'16px',boxShadow:'0 1px 4px rgba(0,0,0,.07)',border:'2px solid #f5a623'}}>
              <div style={{fontWeight:700,fontSize:12,color:'#f5a623',marginBottom:10,textTransform:'uppercase'}}>⏰ Aguardando faturamento no Asaas ({semAsaas.length})</div>
              {semAsaas.slice(0,5).map(c=>(
                <div key={c.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',borderBottom:'1px solid #f8f9fa'}}>
                  <div>
                    <div style={{fontSize:12,fontWeight:600,color:'#2c3e50'}}>{c.nome}</div>
                    <div style={{fontSize:10,color:'#7f8c8d'}}>{c.vendedor} • {moeda(c.total)}</div>
                  </div>
                  <AsaasBadge status="SEM_FATURAMENTO" size="small"/>
                </div>
              ))}
              {semAsaas.length>5&&<div style={{fontSize:11,color:'#7f8c8d',marginTop:8}}>+{semAsaas.length-5} mais</div>}
            </div>
          )}
        </div>
      )}

      {/* COBRANÇAS */}
      {subAba==='cobrancas'&&(
        <div>
          <div style={{display:'flex',gap:6,marginBottom:12,flexWrap:'wrap'}}>
            {[['Todos','Todos'],['RECEIVED','🟢 Em dia'],['PENDING','🟡 Pendente'],['OVERDUE','🔴 Vencido'],['CANCELED','⚫ Cancelado'],['SEM_FATURAMENTO','🔵 Sem fat.']].map(([v,l])=>(
              <button key={v} onClick={()=>setFiltroStatus(v)} style={{padding:'5px 12px',borderRadius:5,border:'none',background:filtroStatus===v?'#27ae60':'#ecf0f1',color:filtroStatus===v?'#fff':'#7f8c8d',cursor:'pointer',fontSize:11,fontWeight:filtroStatus===v?700:400}}>{l}</button>
            ))}
          </div>
          <div style={{background:'#fff',borderRadius:8,boxShadow:'0 1px 4px rgba(0,0,0,.07)',overflow:'hidden'}}>
            <table style={{width:'100%',borderCollapse:'collapse'}}>
              <thead><tr style={{background:'#f8f9fa'}}>
                {['Empresa','Vendedor','Sistema/mês','Vencimento','Status Asaas'].map(h=><th key={h} style={{padding:'8px 12px',textAlign:'left',fontSize:10,color:'#7f8c8d',fontWeight:700,textTransform:'uppercase'}}>{h}</th>)}
              </tr></thead>
              <tbody>
                {listaFiltrada().map((c,i)=>(
                  <tr key={c.id} style={{borderTop:'1px solid #f0f0f0',background:i%2===0?'#fff':'#fdfdfd'}}>
                    <td style={{padding:'8px 12px',fontSize:12,fontWeight:600,color:'#2c3e50'}}>{c.nome}</td>
                    <td style={{padding:'8px 12px',fontSize:11,color:'#7f8c8d'}}>{c.vendedor}</td>
                    <td style={{padding:'8px 12px',fontSize:12,fontWeight:700,color:'#27ae60'}}>{moeda(c.vS||0)}</td>
                    <td style={{padding:'8px 12px',fontSize:11,color:'#7f8c8d'}}>{c.dtBoleto?`Dia ${new Date(c.dtBoleto+'T12:00:00').getDate()}`:'—'}</td>
                    <td style={{padding:'8px 12px'}}><AsaasBadge status={c.asaas_status||'SEM_FATURAMENTO'} size="small"/></td>
                  </tr>
                ))}
                {listaFiltrada().length===0&&<tr><td colSpan={5} style={{padding:'20px',textAlign:'center',color:'#7f8c8d',fontSize:12}}>Nenhum registro encontrado</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ASSINATURAS */}
      {subAba==='assinaturas'&&(
        <div>
          {comAsaas.map(c=>(
            <div key={c.id} style={{background:'#fff',borderRadius:8,padding:'12px 16px',marginBottom:8,boxShadow:'0 1px 4px rgba(0,0,0,.06)',display:'flex',alignItems:'center',gap:12,borderLeft:`4px solid ${(ASAAS_STATUS[c.asaas_status||'SEM_FATURAMENTO']||ASAAS_STATUS.SEM_FATURAMENTO).color}`}}>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:13,color:'#2c3e50'}}>{c.nome}</div>
                <div style={{fontSize:11,color:'#7f8c8d'}}>{c.vendedor} • {moeda(c.vS||0)}/mês • dia {c.dtBoleto?new Date(c.dtBoleto+'T12:00:00').getDate():'—'}</div>
              </div>
              <AsaasBadge status={c.asaas_status||'SEM_FATURAMENTO'} size="small"/>
            </div>
          ))}
          {comAsaas.length===0&&<div style={{background:'#fff',borderRadius:8,padding:'40px',textAlign:'center',color:'#7f8c8d'}}>Nenhuma assinatura ativa no Asaas ainda</div>}
        </div>
      )}

      {/* INADIMPLENTES */}
      {subAba==='inadimplentes'&&(
        <div>
          {vencidos.length===0&&<div style={{background:'#fff',borderRadius:8,padding:'40px',textAlign:'center',color:'#27ae60',fontSize:13,fontWeight:700}}>✅ Nenhum inadimplente! Tudo em dia.</div>}
          {vencidos.map(c=>(
            <div key={c.id} style={{background:'#fff',borderRadius:8,padding:'12px 16px',marginBottom:8,boxShadow:'0 1px 4px rgba(0,0,0,.06)',borderLeft:'4px solid #e74c3c'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                <div>
                  <div style={{fontWeight:700,fontSize:13,color:'#2c3e50',marginBottom:2}}>{c.nome}</div>
                  <div style={{fontSize:11,color:'#7f8c8d'}}>{c.cnpj} • {c.email}</div>
                  <div style={{fontSize:11,color:'#7f8c8d'}}>{c.vendedor} • {moeda(c.vS||0)}/mês</div>
                </div>
                <div style={{textAlign:'right'}}>
                  <AsaasBadge status="OVERDUE"/>
                  {c.tel&&(
                    <div style={{marginTop:6}}>
                      <a href={`https://wa.me/${telParaWa(c.tel)}?text=${encodeURIComponent('Olá! Identificamos que sua mensalidade está em atraso. Por favor, entre em contato conosco.')}`} target="_blank" rel="noopener noreferrer" style={{padding:'4px 10px',borderRadius:5,border:'1px solid #25D366',background:'#fff',fontSize:10,fontWeight:700,color:'#25D366',textDecoration:'none',display:'inline-flex',alignItems:'center',gap:4}}>
                        📲 Cobrar via WhatsApp
                      </a>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* RELATÓRIOS */}
      {subAba==='relatorios'&&(
        <div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))',gap:12,marginBottom:16}}>
            {[
              {l:'MRR Total',v:moeda(mrr),c:'#3498db',desc:'Receita recorrente mensal'},
              {l:'Taxa de adimplência',v:`${Math.round((emDia.length/Math.max(comAsaas.length,1))*100)}%`,c:'#27ae60',desc:`${emDia.length} de ${comAsaas.length} clientes`},
              {l:'Taxa de inadimplência',v:`${Math.round((vencidos.length/Math.max(comAsaas.length,1))*100)}%`,c:'#e74c3c',desc:`${vencidos.length} clientes em atraso`},
              {l:'Sem faturamento',v:semAsaas.length,c:'#f5a623',desc:'Clientes pendentes no Asaas'},
            ].map((card,i)=>(
              <div key={i} style={{background:'#fff',borderRadius:8,padding:'16px',boxShadow:'0 1px 4px rgba(0,0,0,.07)',borderTop:`3px solid ${card.c}`}}>
                <div style={{fontSize:10,color:'#7f8c8d',textTransform:'uppercase',fontWeight:700,marginBottom:6}}>{card.l}</div>
                <div style={{fontSize:24,fontWeight:700,color:card.c}}>{card.v}</div>
                <div style={{fontSize:10,color:'#7f8c8d',marginTop:4}}>{card.desc}</div>
              </div>
            ))}
          </div>
          <div style={{background:'#fff',borderRadius:8,padding:'16px',boxShadow:'0 1px 4px rgba(0,0,0,.07)'}}>
            <div style={{fontWeight:700,fontSize:12,color:'#2c3e50',marginBottom:12,textTransform:'uppercase'}}>Resumo por status</div>
            {[
              {l:'🟢 Em dia',qtd:emDia.length,val:recebidoMes,c:'#27ae60'},
              {l:'🟡 Pendente',qtd:pendentes.length,val:pendentes.reduce((s,c)=>s+(c.vS||0),0),c:'#f5a623'},
              {l:'🔴 Vencido',qtd:vencidos.length,val:inadimplencia,c:'#e74c3c'},
              {l:'⚫ Cancelado',qtd:cancelados.length,val:cancelados.reduce((s,c)=>s+(c.vS||0),0),c:'#7f8c8d'},
              {l:'🔵 Sem faturamento',qtd:semAsaas.length,val:semAsaas.reduce((s,c)=>s+(c.vS||0),0),c:'#3498db'},
            ].map((row,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:'1px solid #f0f0f0'}}>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <div style={{width:8,height:8,borderRadius:'50%',background:row.c}}/>
                  <span style={{fontSize:12,color:'#2c3e50',fontWeight:600}}>{row.l}</span>
                </div>
                <div style={{display:'flex',gap:16,fontSize:12}}>
                  <span style={{color:'#7f8c8d'}}>{row.qtd} clientes</span>
                  <span style={{fontWeight:700,color:row.c}}>{moeda(row.val)}/mês</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// --- FIM MÓDULO ASAAS --------------------------------------------------------

// --- WIDGET FINANCEIRO IA FLUTUANTE ------------------------------------------
// Estado do chat mantido fora do componente para não perder ao re-render
const _chatMsgs={};
const _chatInput={};

function WidgetFinanceiro({currentUser,clientes,todos}){
  const [aberto,setAberto]=useState(false);
  const [aba,setAba]=useState('chat');
  const [msgs,setMsgs]=useState([]);
  const [input,setInput]=useState('');
  const [iaLoading,setIaLoading]=useState(false);
  const [mensagemGerada,setMensagemGerada]=useState('');
  const [clienteMsg,setClienteMsg]=useState(null);
  const [iniciado,setIniciado]=useState(false);
  const chatRef=useRef(null);
  const inputRef=useRef(null);
  const nomeFinanceiro=currentUser?.nome?.split(' ')[0]||'Financeiro';

  const vencidos=clientes.filter(c=>c.asaas_status==='OVERDUE');
  const pendentePix=clientes.filter(c=>(c.asaas_link_impl||c.asaas_link_equip)&&c.asaas_status==='PENDING');
  const semFaturamento=clientes.filter(c=>!c.asaas_id&&!c._base&&c.status==='Aguardando');
  const totalAberto=vencidos.reduce((s,c)=>s+(c.vS||0),0);
  const temAlertas=vencidos.length>0||pendentePix.length>0||semFaturamento.length>0;
  const corWidget=vencidos.length>0?'#e74c3c':temAlertas?'#f5a623':'#27ae60';

  // Scroll automático no chat
  useEffect(()=>{if(chatRef.current)chatRef.current.scrollTop=chatRef.current.scrollHeight;},[msgs]);

  // Mensagem inicial proativa ao abrir pela primeira vez
  useEffect(()=>{
    if(aberto&&!iniciado){
      setIniciado(true);
      const briefing=[];
      if(vencidos.length>0)briefing.push(`🔴 ${vencidos.length} cliente(s) com boleto vencido — total em atraso: ${moeda(totalAberto)}`);
      if(pendentePix.length>0)briefing.push(`🟡 ${pendentePix.length} link(s) Pix aguardando pagamento`);
      if(semFaturamento.length>0)briefing.push(`⏳ ${semFaturamento.length} cliente(s) aguardando faturamento`);
      const resumo=briefing.length>0?briefing.join('\n'):'✅ Tudo em dia! Nenhuma ação urgente.';
      enviarIA(`Olá! Sou o assistente financeiro. Aqui está seu briefing de hoje, ${nomeFinanceiro}:\n\n${resumo}\n\nComo posso te ajudar?`,true);
    }
  },[aberto]);

  async function enviarIA(texto,isBot=false){
    if(isBot){
      setMsgs(m=>[...m,{role:'assistant',content:texto}]);
      return;
    }
    if(!texto.trim())return;
    const novaMsgs=[...msgs,{role:'user',content:texto}];
    setMsgs(novaMsgs);setInput('');setIaLoading(true);
    // Contexto financeiro
    const contexto=`Você é um gerente financeiro consultivo da Guion Informática.
Chame o usuário pelo nome: ${nomeFinanceiro}.
Situação atual:
- Clientes vencidos: ${vencidos.length} (${moeda(totalAberto)} em atraso)
- Links Pix pendentes: ${pendentePix.length}
- Aguardando faturamento: ${semFaturamento.length}
- Total clientes Asaas: ${clientes.filter(c=>c.asaas_id).length}

CLIENTES VENCIDOS (dados reais):
${vencidos.map(c=>`- ${c.nome} | Tel: ${c.tel||'sem tel'} | Email: ${c.email||'sem email'} | Valor: ${moeda(c.vS||0)}/mês | Status: ${c.asaas_status||'OVERDUE'}`).join('\n')||'Nenhum'}

CLIENTES COM PIX PENDENTE:
${pendentePix.map(c=>`- ${c.nome} | Tel: ${c.tel||'sem tel'} | Valor: ${moeda(c.vS||0)}/mês`).join('\n')||'Nenhum'}

CLIENTES AGUARDANDO FATURAMENTO:
${semFaturamento.map(c=>`- ${c.nome} | Vendedor: ${c.vendedor||'—'} | Total: ${moeda(c.total||0)}`).join('\n')||'Nenhum'}

Tom: consultivo, direto, como um gerente experiente ajudando seu financeiro.
Use os dados reais dos clientes para dar sugestões específicas.
Quando gerar mensagem de cobrança, formate para WhatsApp, máximo 4 linhas, inclua o nome do cliente.`;
    try{
      const resposta=await chamadaIA({
        max_tokens:800,
        system:contexto,
        messages:novaMsgs.map(m=>({role:m.role,content:m.content})),
      });
      setMsgs(m=>[...m,{role:'assistant',content:resposta}]);
    }catch(e){
      setMsgs(m=>[...m,{role:'assistant',content:`⚠️ ${e.message}`}]);
    }
    setIaLoading(false);
  }

  async function gerarMensagemCobranca(cliente){
    setClienteMsg(cliente);setIaLoading(true);setMensagemGerada('');
    try{
      const resposta=await chamadaIA({
        max_tokens:400,
        system:`Você é ${nomeFinanceiro} do financeiro da Guion Informática. Escreva mensagem de cobrança simpática e eficaz para WhatsApp. Máximo 4 linhas. Tom cordial.`,
        messages:[{role:'user',content:`Mensagem para ${cliente.contato||cliente.nome} da empresa ${cliente.nome}. Boleto vencido. Valor: ${moeda(cliente.vS||0)}/mês.`}],
      });
      setMensagemGerada(resposta);
    }catch(e){setMensagemGerada(`⚠️ ${e.message}`);}
    setIaLoading(false);
  }

  return(
    <>
      {/* Ícone flutuante */}
      <div onClick={()=>setAberto(a=>!a)} style={{
        position:'fixed',bottom:24,left:24,width:52,height:52,borderRadius:'50%',
        background:corWidget,boxShadow:'0 4px 16px rgba(0,0,0,.25)',
        display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer',
        zIndex:998,transition:'all .2s',
        animation:temAlertas&&!aberto?'pulse 2s infinite':'none',
      }}>
        <span style={{fontSize:22}}>💰</span>
        {temAlertas&&!aberto&&(
          <div style={{position:'absolute',top:-4,right:-4,background:'#e74c3c',color:'#fff',borderRadius:'50%',width:18,height:18,fontSize:10,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center'}}>
            {vencidos.length+semFaturamento.length}
          </div>
        )}
      </div>

      {aberto&&(
        <div style={{position:'fixed',bottom:88,left:24,width:380,height:'65vh',background:'#fff',borderRadius:12,boxShadow:'0 8px 32px rgba(0,0,0,.2)',zIndex:997,display:'flex',flexDirection:'column',overflow:'hidden',fontFamily:'sans-serif'}}>
          {/* Header */}
          <div style={{background:'#2c3e50',padding:'12px 16px',display:'flex',justifyContent:'space-between',alignItems:'center',flexShrink:0}}>
            <div>
              <div style={{color:'#fff',fontWeight:700,fontSize:13}}>💰 Assistente Financeiro</div>
              <div style={{color:'#7f8c8d',fontSize:10,marginTop:1}}>Oi {nomeFinanceiro}!</div>
            </div>
            <button onClick={()=>setAberto(false)} style={{background:'none',border:'none',color:'#7f8c8d',fontSize:18,cursor:'pointer'}}>×</button>
          </div>

          {/* Abas */}
          <div style={{display:'flex',borderBottom:'1px solid #e8eaed',flexShrink:0}}>
            {[['chat','💬 Chat'],['vencidos',`🔴 (${vencidos.length})`],['pendentes',`🟡 (${pendentePix.length})`],['faturar',`⏳ (${semFaturamento.length})`]].map(([id,l])=>(
              <button key={id} onClick={()=>setAba(id)} style={{flex:1,padding:'8px 4px',border:'none',borderBottom:aba===id?'2px solid #f5a623':'2px solid transparent',background:'transparent',cursor:'pointer',fontSize:10,fontWeight:aba===id?700:400,color:aba===id?'#f5a623':'#7f8c8d'}}>{l}</button>
            ))}
          </div>

          {/* CHAT */}
          {aba==='chat'&&(
            <>
              <div ref={chatRef} style={{flex:1,overflowY:'auto',padding:'12px',display:'flex',flexDirection:'column',gap:8}}>
                {msgs.map((m,i)=>(
                  <div key={i} style={{display:'flex',justifyContent:m.role==='user'?'flex-end':'flex-start'}}>
                    <div style={{
                      maxWidth:'85%',padding:'8px 12px',borderRadius:m.role==='user'?'12px 12px 2px 12px':'12px 12px 12px 2px',
                      background:m.role==='user'?'#f5a623':'#f0f2f5',
                      color:m.role==='user'?'#fff':'#2c3e50',
                      fontSize:12,lineHeight:1.5,whiteSpace:'pre-wrap',
                    }}>{m.content}</div>
                  </div>
                ))}
                {iaLoading&&(
                  <div style={{display:'flex',justifyContent:'flex-start'}}>
                    <div style={{background:'#f0f2f5',borderRadius:'12px 12px 12px 2px',padding:'8px 12px',fontSize:12,color:'#7f8c8d'}}>⏳ Pensando...</div>
                  </div>
                )}
              </div>
              <div style={{padding:'10px 12px',borderTop:'1px solid #e8eaed',display:'flex',gap:8,flexShrink:0}}>
                <input
                  ref={inputRef}
                  value={input}
                  onChange={e=>setInput(e.target.value)}
                  onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();enviarIA(input);}}}
                  placeholder="Digite sua mensagem..."
                  style={{flex:1,padding:'8px 12px',borderRadius:20,border:'1px solid #dde1e7',fontSize:12,outline:'none'}}
                />
                <button onClick={()=>enviarIA(input)} disabled={iaLoading||!input.trim()} style={{padding:'8px 16px',borderRadius:20,border:'none',background:iaLoading||!input.trim()?'#e8eaed':'#f5a623',color:'#fff',fontWeight:700,cursor:'pointer',fontSize:12,whiteSpace:'nowrap'}}>
                  Enviar
                </button>
              </div>
            </>
          )}

          {/* VENCIDOS */}
          {aba==='vencidos'&&(
            <div style={{flex:1,overflowY:'auto',padding:'12px'}}>
              {vencidos.length===0&&<div style={{textAlign:'center',color:'#27ae60',padding:'20px',fontSize:12}}>✅ Nenhum vencido!</div>}
              {vencidos.map(c=>(
                <div key={c.id} style={{background:'#fff5f5',borderRadius:8,padding:'10px',marginBottom:8,border:'1px solid #feb2b2'}}>
                  <div style={{fontWeight:700,fontSize:12,color:'#2c3e50',marginBottom:2}}>{c.nome}</div>
                  <div style={{fontSize:11,color:'#7f8c8d',marginBottom:6}}>{moeda(c.vS||0)}/mês</div>
                  {clienteMsg?.id===c.id&&mensagemGerada&&(
                    <div style={{background:'#fff',borderRadius:6,padding:'8px',marginBottom:6,fontSize:11,color:'#2c3e50',border:'1px solid #e8eaed',whiteSpace:'pre-wrap'}}>{mensagemGerada}</div>
                  )}
                  <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                    <button onClick={()=>gerarMensagemCobranca(c)} disabled={iaLoading&&clienteMsg?.id===c.id} style={{padding:'4px 10px',borderRadius:5,border:'none',background:'#f5a623',color:'#fff',fontWeight:700,cursor:'pointer',fontSize:10}}>
                      {iaLoading&&clienteMsg?.id===c.id?'⏳':'🤖 Gerar msg'}
                    </button>
                    {mensagemGerada&&clienteMsg?.id===c.id&&<>
                      <button onClick={()=>navigator.clipboard.writeText(mensagemGerada)} style={{padding:'4px 10px',borderRadius:5,border:'1px solid #dde1e7',background:'#fff',cursor:'pointer',fontSize:10}}>📋 Copiar</button>
                      {c.tel&&<a href={`https://wa.me/${telParaWa(c.tel)}?text=${encodeURIComponent(mensagemGerada)}`} target="_blank" rel="noopener noreferrer" style={{padding:'4px 10px',borderRadius:5,border:'none',background:'#25D366',color:'#fff',fontWeight:700,fontSize:10,textDecoration:'none'}}>📲 WA</a>}
                    </>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* PIX PENDENTE */}
          {aba==='pendentes'&&(
            <div style={{flex:1,overflowY:'auto',padding:'12px'}}>
              {pendentePix.length===0&&<div style={{textAlign:'center',color:'#27ae60',padding:'20px',fontSize:12}}>✅ Nenhum Pix pendente!</div>}
              {pendentePix.map(c=>(
                <div key={c.id} style={{background:'#fff8ee',borderRadius:8,padding:'10px',marginBottom:8,border:'1px solid #fde68a'}}>
                  <div style={{fontWeight:700,fontSize:12,color:'#2c3e50',marginBottom:2}}>{c.nome}</div>
                  <div style={{fontSize:11,color:'#7f8c8d',marginBottom:6}}>Link enviado — aguardando</div>
                  {c.tel&&<a href={`https://wa.me/${telParaWa(c.tel)}?text=${encodeURIComponent('Olá! Passando para lembrar do link de pagamento 😊')}`} target="_blank" rel="noopener noreferrer" style={{padding:'4px 10px',borderRadius:5,border:'none',background:'#25D366',color:'#fff',fontWeight:700,fontSize:10,textDecoration:'none',display:'inline-block'}}>📲 Lembrar</a>}
                </div>
              ))}
            </div>
          )}

          {/* FATURAR */}
          {aba==='faturar'&&(
            <div style={{flex:1,overflowY:'auto',padding:'12px'}}>
              {semFaturamento.length===0&&<div style={{textAlign:'center',color:'#27ae60',padding:'20px',fontSize:12}}>✅ Todos faturados!</div>}
              {semFaturamento.map(c=>(
                <div key={c.id} style={{background:'#ebf8ff',borderRadius:8,padding:'10px',marginBottom:8,border:'1px solid #bee3f8'}}>
                  <div style={{fontWeight:700,fontSize:12,color:'#2c3e50',marginBottom:2}}>{c.nome}</div>
                  <div style={{fontSize:11,color:'#7f8c8d'}}>{c.vendedor} • {moeda(c.total)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <style>{`@keyframes pulse{0%,100%{box-shadow:0 4px 16px rgba(0,0,0,.25)}50%{box-shadow:0 4px 24px rgba(231,76,60,.5)}}`}</style>
    </>
  );
}

// --- APP PRINCIPAL ------------------------------------------------------------
export default function App(){
  const [authUser,setAuthUser]=useState(null);
  const [authLoading,setAuthLoading]=useState(true);
  const [userProfile,setUserProfile]=useState(null);
  useEffect(()=>{document.title='Guion - CRM';},[]);
  const [clientes,setClientes]=useState([]);
  const [overrides,setOverrides]=useState({});
  const [implantacoes,setImplantacoes]=useState({});
  const [usuarios,setUsuarios]=useState([]);
  const [page,setPage]=useState('dashboard');
  const [clienteSel,setClienteSel]=useState(null);
  const [busca,setBusca]=useState('');
  const [filtroAno,setFiltroAno]=useState('Todos');
  const [filtroMes,setFiltroMes]=useState('Todos');
  const [filtroVendedor,setFiltroVendedor]=useState('Todos');
  const [filtroPlano,setFiltroPlano]=useState('Todos');
  const [filtroStatus,setFiltroStatus]=useState('Todos');
  const [vendedoresCad,setVendedoresCad]=useState([]);
  const [equipamentosCad,setEquipamentosCad]=useState([]);
  const [solicitacoes,setSolicitacoes]=useState([]);
  const [orcamentos,setOrcamentos]=useState([]);
  const [orcServicos,setOrcServicos]=useState([]);
  const [orcFormas,setOrcFormas]=useState([]);
  const [orcTemplates,setOrcTemplates]=useState([]);
  const [dadosImportados,setDadosImportados]=useState(null);
  const [menuOrder,setMenuOrder]=useState(null);
  const [metaSistema,setMetaSistema]=useState(()=>{try{return parseFloat(localStorage.getItem('crm_meta_sistema'))||0;}catch(e){return 0;}});
  const [metaEquip,setMetaEquip]=useState(()=>{try{return parseFloat(localStorage.getItem('crm_meta_equip'))||0;}catch(e){return 0;}});
  function salvarMetaSistema(v){setMetaSistema(v);try{localStorage.setItem('crm_meta_sistema',String(v));}catch(e){}}
  function salvarMetaEquip(v){setMetaEquip(v);try{localStorage.setItem('crm_meta_equip',String(v));}catch(e){}}

  // Sino: refs para detectar novos itens
  const prevSolIds=useRef(null);
  const prevClienteIds=useRef(null);
  const prevImplAtrasados=useRef(null);

  useEffect(()=>{
    if(prevSolIds.current===null){prevSolIds.current=new Set(solicitacoes.map(s=>s.id));return;}
    const novos=solicitacoes.filter(s=>!prevSolIds.current.has(s.id)&&s.responsavelId===userProfile?.id);
    if(novos.length>0)tocarSino(3);
    prevSolIds.current=new Set(solicitacoes.map(s=>s.id));
  },[solicitacoes]);

  useEffect(()=>{
    if(prevClienteIds.current===null){prevClienteIds.current=new Set(clientes.map(c=>c.id));return;}
    const novos=clientes.filter(c=>!prevClienteIds.current.has(c.id));
    if(novos.length>0)tocarSino(3);
    prevClienteIds.current=new Set(clientes.map(c=>c.id));
  },[clientes]);

  // Auth listener
  useEffect(()=>{
    return onAuthStateChanged(auth,async user=>{
      setAuthUser(user);
      if(user){
        try{
          const snap=await getDocs(collection(db,'usuarios'));
          const perfis={};
          snap.forEach(d=>perfis[d.id]={id:d.id,...d.data()});
          const perfil=perfis[user.uid]||{email:user.email,perfil:'admin',nome:user.email};
          setUserProfile(perfil);
          setUsuarios(Object.values(perfis));
          // Carregar ordem do menu do Firestore
          if(perfil.menuOrder&&perfil.menuOrder.length){
            setMenuOrder(perfil.menuOrder);
          }
        }catch(e){setUserProfile({email:user.email,perfil:'admin',nome:user.email});}
      }
      setAuthLoading(false);
    });
  },[]);

  // Listeners do Firestore (tempo real)
  useEffect(()=>{
    if(!authUser)return;
    const unsubs=[];
    unsubs.push(onSnapshot(collection(db,'clientes'),snap=>{
      const arr=[];snap.forEach(d=>arr.push({id:d.id,...d.data()}));
      setClientes(arr);
    }));
    unsubs.push(onSnapshot(collection(db,'overrides'),snap=>{
      const obj={};snap.forEach(d=>obj[d.id]=d.data());setOverrides(obj);
    }));
    unsubs.push(onSnapshot(collection(db,'implantacoes'),snap=>{
      const obj={};snap.forEach(d=>obj[d.id]=d.data());setImplantacoes(obj);
    }));
    unsubs.push(onSnapshot(collection(db,'usuarios'),snap=>{
      const arr=[];snap.forEach(d=>arr.push({id:d.id,...d.data()}));setUsuarios(arr);
    }));
    unsubs.push(onSnapshot(collection(db,'vendedores'),snap=>{
      const arr=[];snap.forEach(d=>arr.push({id:d.id,...d.data()}));setVendedoresCad(arr);
    }));
    unsubs.push(onSnapshot(collection(db,'equipamentos'),snap=>{
      const arr=[];snap.forEach(d=>arr.push({id:d.id,...d.data()}));setEquipamentosCad(arr);
    }));
    unsubs.push(onSnapshot(collection(db,'solicitacoes'),snap=>{
      const arr=[];snap.forEach(d=>arr.push({id:d.id,...d.data()}));setSolicitacoes(arr);
    }));
    unsubs.push(onSnapshot(collection(db,'orcamentos'),snap=>{
      const arr=[];snap.forEach(d=>arr.push({id:d.id,...d.data()}));setOrcamentos(arr);
    }));
    unsubs.push(onSnapshot(collection(db,'orc_servicos'),snap=>{
      const arr=[];snap.forEach(d=>arr.push({id:d.id,...d.data()}));setOrcServicos(arr);
    }));
    unsubs.push(onSnapshot(collection(db,'orc_formas'),snap=>{
      const arr=[];snap.forEach(d=>arr.push({id:d.id,...d.data()}));setOrcFormas(arr);
    }));
    unsubs.push(onSnapshot(collection(db,'orc_templates'),snap=>{
      const arr=[];snap.forEach(d=>arr.push({id:d.id,...d.data()}));setOrcTemplates(arr);
    }));
    return()=>unsubs.forEach(u=>u());
  },[authUser]);

  // Funções de persistência
  async function salvarCliente(dados){
    const ref=doc(collection(db,'clientes'));
    await setDoc(ref,{...dados,id:ref.id});
  }
  async function atualizarCliente(id,dados){
    if(id.startsWith('base_')){
      await setDoc(doc(db,'overrides',id),dados);
    } else {
      await setDoc(doc(db,'clientes',id),dados,{merge:true});
    }
    if(clienteSel?.id===id)setClienteSel(c=>({...c,...dados}));
  }
  async function salvarImpl(id,dados){
    await setDoc(doc(db,'implantacoes',String(id)),dados,{merge:true});
  }

  const todos=useMemo(()=>[
    ...CLIENTES_BASE.map(c=>overrides[c.id]?{...c,...overrides[c.id]}:c),
    ...clientes
  ],[clientes,overrides]);

  const perfil=userProfile?.perfil||'admin';
  const navItemsOrdenados=getNavItems(menuOrder);

  const cl=useMemo(()=>todos.filter(c=>{
    if(filtroAno!=='Todos'&&c.ano!==+filtroAno)return false;
    if(filtroMes!=='Todos'&&c.mes!==+filtroMes)return false;
    if(filtroVendedor!=='Todos'&&c.vendedor!==filtroVendedor)return false;
    if(filtroPlano!=='Todos'&&c.plano!==filtroPlano)return false;
    if(filtroStatus!=='Todos'&&c.status!==filtroStatus)return false;
    if(busca){const q=busca.toLowerCase();if(!c.nome.toLowerCase().includes(q)&&!c.cnpj.includes(q)&&!c.email.toLowerCase().includes(q))return false;}
    return true;
  }),[todos,filtroAno,filtroMes,filtroVendedor,filtroPlano,filtroStatus,busca]);

  const fat=cl.filter(c=>c.status==='Faturado');
  const agd=cl.filter(c=>c.status==='Aguardando');
  const totFat=fat.reduce((s,c)=>s+c.total,0);
  const totAgd=agd.reduce((s,c)=>s+c.total,0);
  const totGeral=cl.reduce((s,c)=>s+c.total,0);
  const totImpl=cl.reduce((s,c)=>s+c.vI,0);
  const totEquip=cl.reduce((s,c)=>s+c.vE,0);
  const totSist=cl.reduce((s,c)=>s+c.vS,0);
  const anosDisp=[...new Set(todos.map(c=>c.ano).filter(Boolean))].sort();
  const vendedoresDin=['Todos',...new Set(todos.map(c=>c.vendedor).filter(v=>v&&v!=='—'))].sort();
  const porMes=MESES.map((_,m)=>{const anoRef=filtroAno==='Todos'?null:+filtroAno;const cs=todos.filter(c=>c.mes===m&&(anoRef===null||c.ano===anoRef));return{m,fat:cs.filter(c=>c.status==='Faturado').reduce((s,c)=>s+c.total,0),qtd:cs.length};});
  const porVend=[...new Set(todos.map(c=>c.vendedor).filter(v=>v&&v!=='—'))].map(v=>{const cs=cl.filter(c=>c.vendedor===v);return{v,qtd:cs.length,total:cs.reduce((s,c)=>s+c.total,0),fat:cs.filter(c=>c.status==='Faturado').reduce((s,c)=>s+c.total,0)};}).filter(x=>x.qtd>0).sort((a,b)=>b.fat-a.fat);
  const porPlano=['Basic','Pro','Ultimate'].map(p=>{const cs=cl.filter(c=>c.plano===p);return{p,qtd:cs.length,total:cs.reduce((s,c)=>s+c.total,0)};});
  const maxVend=Math.max(...porVend.map(x=>x.fat),1);
 // const maxAno=Math.max(...[...new Set(todos.map(c=>c.ano).filter(Boolean))].map(a=>todos.filter(c=>c.ano===a).reduce((s,c)=>s+c.total,0)),1);

  if(authLoading)return <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'#2c3e50',color:'#fff',fontSize:16,fontFamily:'sans-serif'}}>Carregando...</div>;
  if(!authUser)return <LoginScreen/>;

  const fi={padding:'7px 10px',borderRadius:5,border:`1px solid ${C.border}`,fontSize:12,color:C.text,background:'#fff'};
  const navItems=navItemsOrdenados.filter(n=>n.perfis.includes(perfil));
  const sidebarItems=getSidebarItems(menuOrder,perfil);
  const filtroAtivo=busca||filtroAno!=='Todos'||filtroMes!=='Todos'||filtroVendedor!=='Todos'||filtroPlano!=='Todos'||filtroStatus!=='Todos';

  return(
    <div style={{display:'flex',minHeight:'100vh',fontFamily:"'Segoe UI',sans-serif",background:C.bg,fontSize:13}}>

      {/* SIDEBAR */}
      <div style={{width:200,background:C.sidebar,flexShrink:0,display:'flex',flexDirection:'column'}}>
        <div style={{padding:'18px 16px',borderBottom:'1px solid rgba(255,255,255,.08)'}}>
          <div style={{marginBottom:4}}>{LOGO_SIDEBAR_SVG}</div>
          <div style={{color:'#7f8c8d',fontSize:9,marginTop:4,letterSpacing:.5}}>{todos.length} clientes cadastrados</div>
        </div>
        <div style={{padding:'12px 8px',flex:1}}>
          <div style={{fontSize:9,color:'#7f8c8d',fontWeight:700,textTransform:'uppercase',letterSpacing:1,padding:'0 8px',marginBottom:8}}>Menu</div>
          {sidebarItems.map(n=>{
            if(n.isSep)return <div key={n.id} style={{height:1,background:'rgba(255,255,255,.08)',margin:'6px 8px'}}/>;
            const iconColors={'dashboard':'#3498db','vendas':'#27ae60','financeiro':'#e67e22','asaas':'#27ae60','clientes':'#9b59b6','novo':'#2ecc71','implantacao':'#e74c3c','relatorios':'#1abc9c','solicitacoes':'#f39c12','orcamentos':'#2980b9','config':'#95a5a6'};
            const svgIcons={
              // Dashboard: monitor com gráfico
              dashboard:<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><polyline points="8 21 12 17 16 21"/><line x1="12" y1="17" x2="12" y2="21"/><polyline points="6 10 9 7 12 10 16 6"/></svg>,
              // Vendas: aperto de mão
              vendas:<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.42 4.58a5.4 5.4 0 0 0-7.65 0l-.77.78-.77-.78a5.4 5.4 0 0 0-7.65 0C1.46 6.7 1.33 10.28 4 13l8 8 8-8c2.67-2.72 2.54-6.3.42-8.42z"/><path d="M12 5.36 8.87 8.5a2.13 2.13 0 0 0 0 3h0a2.13 2.13 0 0 0 3.02 0L12 11l.11.5a2.13 2.13 0 0 0 3.02 0h0a2.13 2.13 0 0 0 0-3z"/></svg>,
              // Financeiro: carteira com dinheiro
              financeiro:<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/><circle cx="16" cy="15" r="1" fill="currentColor"/></svg>,
              // Asaas: banco/cifrão
              asaas:<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>,
              // Clientes: grupo de pessoas
              clientes:<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
              // Novo cliente: pessoa com sinal de +
              novo:<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="16" y1="11" x2="22" y2="11"/></svg>,
              // Implantação: chave inglesa + parafuso
              implantacao:<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>,
              // Relatórios: planilha com linhas e colunas
              relatorios:<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>,
              // Solicitações: caixa de entrada / ticket
              solicitacoes:<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>,
              orcamentos:<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>,
              // Configurações: engrenagem
              config:<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
            };
            const ativo=page===n.id;
            const cor=iconColors[n.id]||'#3498db';
            const corAtivo='#f5a623';
            const hoje2=new Date();hoje2.setHours(0,0,0,0);
            const badgeSol=solicitacoes.filter(s=>(s.status==='Aberta'||s.status==='Em andamento')&&s.responsavelId===userProfile?.id).length;
            const badgeImpl=todos.filter(c=>{const impl=implantacoes[c.id]||{};if(impl.etapa==='processo_finalizado')return false;if(!impl.prazo)return true;return new Date(impl.prazo+'T12:00:00')<hoje2;}).length;
            const hojeStr=hoje2.toISOString().split('T')[0];
            const badgeNovo=clientes.filter(c=>{if(!c.criadoEm)return false;return c.criadoEm.startsWith(hojeStr);}).length;
            const badge=n.id==='solicitacoes'?badgeSol:n.id==='implantacao'?badgeImpl:n.id==='novo'?badgeNovo:0;
            return(
              <div key={n.id} onClick={()=>{setPage(n.id);setClienteSel(null);setFiltroAno('Todos');setFiltroMes('Todos');setFiltroVendedor('Todos');setFiltroPlano('Todos');setFiltroStatus('Todos');setBusca('');}} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 10px',borderRadius:7,cursor:'pointer',background:ativo?corAtivo:'transparent',marginBottom:3,transition:'background .15s',position:'relative'}}>
                <div style={{width:28,height:28,borderRadius:6,background:ativo?'rgba(255,255,255,.25)':cor,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,boxShadow:ativo?'none':'0 1px 3px rgba(0,0,0,.2)'}}>
                  <span style={{color:'#fff',display:'flex',alignItems:'center',justifyContent:'center'}}>{svgIcons[n.id]||svgIcons.config}</span>
                </div>
                <span style={{fontSize:13,fontWeight:ativo?700:400,color:ativo?'#fff':'#bdc3c7',flex:1}}>{n.label}</span>
                {badge>0&&<span style={{background:'#e67e22',color:'#fff',borderRadius:10,fontSize:10,fontWeight:700,padding:'1px 6px',minWidth:18,textAlign:'center',flexShrink:0}}>{badge}</span>}
              </div>
            );
          })}
        </div>
        <div style={{padding:'10px 12px',borderTop:'1px solid rgba(255,255,255,.08)'}}>
          <div style={{fontSize:9,color:'#7f8c8d',fontWeight:600,textTransform:'uppercase',letterSpacing:.8,textAlign:'center'}}>{userProfile?.perfil?.toUpperCase()||'ADMIN'}</div>
        </div>
      </div>

      {/* MAIN */}
      <div style={{flex:1,display:'flex',flexDirection:'column',minWidth:0}}>
        {/* HEADER BRANCO estilo Secullum */}
        <div style={{background:'#ffffff',padding:'0 24px',display:'flex',alignItems:'center',justifyContent:'space-between',borderBottom:'1px solid #e8eaed',height:56,flexShrink:0}}>
          {/* Título da página atual */}
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            <div style={{width:3,height:22,background:'#f5a623',borderRadius:2}}/>
            <span style={{fontWeight:700,fontSize:14,color:'#4a4a4a',textTransform:'uppercase',letterSpacing:1.2}}>
              {navItems.find(n=>n.id===page)?.label||'Dashboard'}
            </span>
          </div>
          {/* Busca + usuário */}
          <div style={{display:'flex',alignItems:'center',gap:16}}>
            <div style={{position:'relative',display:'flex',alignItems:'center'}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#aaa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{position:'absolute',left:10,pointerEvents:'none',zIndex:1}}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input value={busca} onChange={e=>setBusca(e.target.value.toUpperCase())} placeholder="BUSCAR CLIENTE..." style={{paddingLeft:32,paddingRight:busca?28:10,height:34,borderRadius:7,border:'1.5px solid #e8eaed',background:'#f5f6fa',color:'#4a4a4a',fontSize:12,width:220,outline:'none',boxSizing:'border-box',fontFamily:'inherit'}}/>
              {busca&&<button onClick={()=>setBusca('')} style={{position:'absolute',right:6,background:'none',border:'none',cursor:'pointer',color:'#aaa',fontSize:16,lineHeight:1,padding:0,display:'flex',alignItems:'center'}}>×</button>}
            </div>
            {/* Versão / build */}
            <div style={{fontSize:10,color:'#bdc3c7',borderLeft:'1px solid #e8eaed',paddingLeft:12,lineHeight:1.4,display:'flex',flexDirection:'column',alignItems:'flex-end'}}>
              <span style={{color:'#27ae60',fontWeight:700}}>● ao vivo</span>
              <span>{new Date(process.env.REACT_APP_BUILD_TIME||Date.now()).toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'})} {new Date(process.env.REACT_APP_BUILD_TIME||Date.now()).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',timeZone:'America/Sao_Paulo'})}</span>
            </div>
            {/* Avatar + nome usuário */}
            <div style={{display:'flex',alignItems:'center',gap:8,borderLeft:'1px solid #e8eaed',paddingLeft:16}}>
              <div style={{width:32,height:32,borderRadius:'50%',background:'#f5a623',display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontWeight:700,fontSize:13}}>{(userProfile?.nome||userProfile?.email||'A')[0].toUpperCase()}</div>
              <div>
                <div style={{fontSize:12,fontWeight:600,color:'#4a4a4a',lineHeight:1.2}}>{userProfile?.nome||userProfile?.email}</div>
                <div style={{fontSize:10,color:'#7f8c8d'}}>{PERFIS[userProfile?.perfil||'admin']?.label}</div>
              </div>
              <button onClick={()=>signOut(auth)} title="Sair" style={{background:'none',border:'none',cursor:'pointer',color:'#aaa',fontSize:18,display:'flex',alignItems:'center',marginLeft:4}}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
              </button>
            </div>
          </div>
        </div>

        <div style={{flex:1,overflowY:'auto',padding:'20px',background:'#f5f6fa'}}>
          {/* FILTROS */}
          {page!=='novo'&&!clienteSel&&page!=='implantacao'&&page!=='config'&&(
            <div style={{display:'flex',gap:8,marginBottom:16,flexWrap:'wrap',alignItems:'center'}}>
              <select value={filtroAno} onChange={e=>setFiltroAno(e.target.value)} style={fi}>
                <option value="Todos">📅 Todos os anos</option>
                {anosDisp.map(a=><option key={a}>{a}</option>)}
              </select>
              <select value={filtroMes} onChange={e=>setFiltroMes(e.target.value)} style={fi}>
                <option value="Todos">🗓 Todos os meses</option>
                {MESES.map((m,i)=><option key={i} value={i}>{m}</option>)}
              </select>
              <select value={filtroVendedor} onChange={e=>setFiltroVendedor(e.target.value)} style={fi}>
                {vendedoresDin.map(v=><option key={v} value={v}>{v==='Todos'?'👤 Vendedor':v}</option>)}
              </select>
              <select value={filtroPlano} onChange={e=>setFiltroPlano(e.target.value)} style={fi}>
                <option value="Todos">🏷 Plano</option>
                {['Basic','Pro','Ultimate'].map(p=><option key={p}>{p}</option>)}
              </select>
              <select value={filtroStatus} onChange={e=>setFiltroStatus(e.target.value)} style={fi}>
                <option value="Todos">📋 Status</option>
                <option value="Faturado">✅ Faturado</option>
                <option value="Aguardando">⏳ Aguardando</option>
              </select>
              {filtroAtivo&&<button onClick={()=>{setFiltroAno('Todos');setFiltroMes('Todos');setFiltroVendedor('Todos');setFiltroPlano('Todos');setFiltroStatus('Todos');setBusca('');}} style={{...fi,background:'#fadbd8',border:'1px solid #f1948a',color:'#e74c3c',cursor:'pointer',padding:'6px 12px'}}>✕ Limpar</button>}
              <span style={{fontSize:11,color:C.textMuted,marginLeft:4}}>{cl.length} cliente(s)</span>
            </div>
          )}

          {/* NOVO */}
          {page==='novo'&&<NovoForm
            onSave={async d=>{
              // 1. Salva o cliente no Firestore
              const ref=doc(collection(db,'clientes'));
              const novoId=ref.id;
              const dadosSalvos={...d,id:novoId};
              await setDoc(ref,dadosSalvos);
              // 2. Gera links Pix/Cartão no Asaas se necessário
              let dadosAsaas={};
              const precisaAsaas=(d.pagamentoI==='Pix'||d.pagamentoI==='Cartão')&&d.vI>0
                ||(d.pagamentoE==='Pix'||d.pagamentoE==='Cartão')&&d.vE>0;
              if(precisaAsaas){
                try{
                  const asaasCliente=await asaasCriarOuBuscarCliente(d);
                  dadosAsaas.asaas_id=asaasCliente.id;
                  // Link implantação Pix/Cartão
                  if((d.pagamentoI==='Pix'||d.pagamentoI==='Cartão')&&d.vI>0){
                    const billingType=d.pagamentoI==='Pix'?'PIX':'CREDIT_CARD';
                    const link=await asaasCriarLinkPagamento(asaasCliente.id,d.vI,billingType,`Implantação — ${d.nome}`);
                    dadosAsaas.asaas_link_impl=link.url||link.invoiceUrl||link.paymentLink||'';
                    dadosAsaas.asaas_link_impl_id=link.id||'';
                    dadosAsaas.asaas_status_impl='PENDING';
                    dadosAsaas.asaas_link_impl_tipo=d.pagamentoI;
                  }
                  // Link equipamento Pix/Cartão
                  if((d.pagamentoE==='Pix'||d.pagamentoE==='Cartão')&&d.vE>0){
                    const billingType=d.pagamentoE==='Pix'?'PIX':'CREDIT_CARD';
                    const link=await asaasCriarLinkPagamento(asaasCliente.id,d.vE,billingType,`Equipamento — ${d.nome}`);
                    dadosAsaas.asaas_link_equip=link.url||link.invoiceUrl||link.paymentLink||'';
                    dadosAsaas.asaas_link_equip_id=link.id||'';
                    dadosAsaas.asaas_status_equip='PENDING';
                    dadosAsaas.asaas_link_equip_tipo=d.pagamentoE;
                  }
                  // Atualiza Firestore com dados do Asaas
                  if(Object.keys(dadosAsaas).length>0){
                    await setDoc(ref,dadosAsaas,{merge:true});
                  }
                }catch(err){
                  console.error('Erro ao gerar link Asaas:',err);
                }
              }
              // 3. Vai para o detalhe do cliente (não fecha para lista)
              const clienteCompleto={...dadosSalvos,...dadosAsaas};
              setDadosImportados(null);
              setClienteSel(clienteCompleto);
              setPage('clientes');
            }}
            onCancel={()=>{setDadosImportados(null);setPage('clientes');}}
            vendedoresCad={vendedoresCad}
            equipamentosCad={equipamentosCad}
            dadosImportados={dadosImportados}
            currentUser={userProfile}
          />}

          {/* DETALHE */}
          {clienteSel&&page!=='novo'&&<DetalheCliente c={clienteSel} onVoltar={()=>setClienteSel(null)} onUpdate={async u=>{await atualizarCliente(u.id,u);}} vendedoresCad={vendedoresCad} equipamentosCad={equipamentosCad} perfil={perfil}/>}

          {/* IMPLANTAÇÃO */}
          {!clienteSel&&page==='implantacao'&&<KanbanView todos={todos} implantacoes={implantacoes} onSalvarImpl={salvarImpl} currentUser={userProfile}/>}

          {/* CONFIGURAÇÕES */}
          {!clienteSel&&page==='config'&&<ConfigView usuarios={usuarios} currentUser={userProfile} vendedoresCad={vendedoresCad} equipamentosCad={equipamentosCad} menuOrder={menuOrder} onMenuOrderChange={order=>{setMenuOrder(order);}} orcServicos={orcServicos} orcFormas={orcFormas} orcTemplates={orcTemplates}/>}

          {/* DASHBOARD */}
          {!clienteSel&&page==='dashboard'&&<DashboardView
            todos={todos} cl={cl} fat={fat} agd={agd}
            totFat={totFat} totAgd={totAgd} totGeral={totGeral}
            totSist={totSist} totEquip={totEquip} totImpl={totImpl}
            porMes={porMes} porVend={porVend} porPlano={porPlano} maxVend={maxVend}
            solicitacoes={solicitacoes} implantacoes={implantacoes} clientes={clientes}
            metaSistema={metaSistema} metaEquip={metaEquip}
            salvarMetaSistema={salvarMetaSistema} salvarMetaEquip={salvarMetaEquip}
            setPage={setPage} setClienteSel={setClienteSel}
            setFiltroStatus={setFiltroStatus}
            filtroVendedor={filtroVendedor} setFiltroVendedor={setFiltroVendedor}
          />}

          {/* VENDAS */}
          {!clienteSel&&page==='vendas'&&(
            <div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))',gap:12,marginBottom:20}}>
                <StatCard icon="ti-users" label="Total" value={cl.length} sub={`${fat.length} fat.`} color={C.blue}/>
                <StatCard icon="ti-check" label="Faturados" value={fat.length} color={C.green} onClick={()=>setFiltroStatus('Faturado')}/>
                <StatCard icon="ti-clock" label="Aguardando" value={agd.length} color={C.orange} onClick={()=>setFiltroStatus('Aguardando')}/>
                <StatCard icon="ti-user-check" label="Funcionários" value={cl.reduce((s,c)=>s+c.func,0).toLocaleString()} color={C.teal}/>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:14}}>
                <div style={{background:C.card,borderRadius:8,padding:'16px',boxShadow:'0 1px 3px rgba(0,0,0,.08)'}}>
                  <div style={{fontWeight:700,fontSize:12,color:C.text,marginBottom:12,textTransform:'uppercase'}}>Clientes por ano</div>
                  {anosDisp.map(ano=>{const cs=todos.filter(c=>c.ano===ano);const pct=Math.round((cs.filter(c=>c.status==='Faturado').length/Math.max(cs.length,1))*100);
                    return <div key={ano} onClick={()=>setFiltroAno(filtroAno===String(ano)?'Todos':String(ano))} style={{display:'flex',alignItems:'center',gap:10,padding:'6px 8px',borderRadius:5,cursor:'pointer',background:filtroAno===String(ano)?'#ebf5fb':'transparent',marginBottom:2}}>
                      <span style={{fontWeight:700,width:36,color:C.blue}}>{ano}</span>
                      <div style={{flex:1,height:8,borderRadius:4,background:'#ecf0f1'}}><div style={{height:'100%',borderRadius:4,background:C.blue,width:`${pct}%`}}/></div>
                      <span style={{fontSize:11,color:C.textMuted,width:50,textAlign:'right'}}>{cs.length} cli.</span>
                    </div>;
                  })}
                </div>
                <div style={{background:C.card,borderRadius:8,padding:'16px',boxShadow:'0 1px 3px rgba(0,0,0,.08)'}}>
                  <div style={{fontWeight:700,fontSize:12,color:C.text,marginBottom:12,textTransform:'uppercase'}}>Por plano</div>
                  <div style={{display:'flex',alignItems:'center',gap:16}}>
                    <Donut vals={porPlano.map(p=>p.qtd)} colors={[C.blue,C.purple,C.orange]} size={90} label={cl.length} sub="total"/>
                    <div style={{flex:1}}>
                      {porPlano.map(({p,qtd,total},i)=>{const cors=[C.blue,C.purple,C.orange];
                        return <div key={p} onClick={()=>setFiltroPlano(filtroPlano===p?'Todos':p)} style={{display:'flex',alignItems:'center',gap:8,padding:'5px 8px',borderRadius:5,cursor:'pointer',marginBottom:2,background:filtroPlano===p?'#f8f9fa':'transparent'}}>
                          <div style={{width:10,height:10,borderRadius:2,background:cors[i]}}/><span style={{flex:1,fontSize:12,fontWeight:600}}>{p}</span><span style={{fontSize:13,fontWeight:700}}>{qtd}</span><span style={{fontSize:10,color:C.textMuted,marginLeft:4}}>{moeda(total)}</span>
                        </div>;
                      })}
                    </div>
                  </div>
                </div>
              </div>
              <div style={{background:C.card,borderRadius:8,padding:'16px',boxShadow:'0 1px 3px rgba(0,0,0,.08)'}}>
                <div style={{fontWeight:700,fontSize:12,color:C.text,marginBottom:12,textTransform:'uppercase'}}>Ranking vendedores</div>
                {porVend.map(({v,qtd,total,fat},rank)=>{
                  const medals=['🥇','🥈','🥉'];
                  return <div key={v} onClick={()=>setFiltroVendedor(filtroVendedor===v?'Todos':v)} style={{display:'flex',alignItems:'center',gap:10,padding:'8px',borderRadius:8,marginBottom:4,cursor:'pointer',background:filtroVendedor===v?'#ebf5fb':'transparent'}}>
                    <span style={{fontSize:18,width:22}}>{medals[rank]||'🎖'}</span>
                    <div style={{width:32,height:32,borderRadius:'50%',background:C.blue,display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontSize:12,fontWeight:700,flexShrink:0}}>{v[0]}</div>
                    <div style={{flex:1}}>
                      <div style={{display:'flex',justifyContent:'space-between',fontSize:12}}><span style={{fontWeight:600}}>{v}</span><span style={{fontWeight:700,color:C.green}}>{moeda(fat)}</span></div>
                      <div style={{height:4,borderRadius:2,background:'#ecf0f1',marginTop:4}}><div style={{height:'100%',borderRadius:2,background:C.blue,width:`${Math.round((fat/maxVend)*100)}%`}}/></div>
                      <div style={{fontSize:10,color:C.textMuted,marginTop:1}}>{qtd} clientes</div>
                    </div>
                  </div>;
                })}
              </div>
            </div>
          )}

          {/* FINANCEIRO */}
          {!clienteSel&&page==='financeiro'&&(
            <div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))',gap:12,marginBottom:20}}>
                <StatCard icon="ti-currency-dollar" label="Total geral" value={moeda(totGeral)} color={C.blue}/>
                <StatCard icon="ti-check" label="Faturado" value={moeda(totFat)} sub={`${fat.length} clientes`} color={C.green} onClick={()=>setFiltroStatus('Faturado')}/>
                <StatCard icon="ti-clock" label="A faturar" value={moeda(totAgd)} sub={`${agd.length} pendentes`} color={C.orange} onClick={()=>setFiltroStatus('Aguardando')}/>
                <StatCard icon="ti-device-laptop" label="Equipamentos" value={moeda(totEquip)} color={C.teal}/>
                <StatCard icon="ti-code" label="Sistema" value={moeda(totSist)} color={C.purple}/>
                <StatCard icon="ti-tools" label="Implantação" value={moeda(totImpl)} color={C.orange}/>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:12,marginBottom:14}}>
                <div style={{background:C.card,borderRadius:8,padding:'16px',boxShadow:'0 1px 3px rgba(0,0,0,.08)'}}>
                  <div style={{fontWeight:700,fontSize:12,color:C.text,marginBottom:4,textTransform:'uppercase'}}>Faturamento por mês</div>
                  <BarChart data={porMes.map(p=>({l:MESES[p.m].slice(0,3),v:p.fat}))} color={C.green} height={120}/>
                </div>
                <div style={{background:C.card,borderRadius:8,padding:'16px',boxShadow:'0 1px 3px rgba(0,0,0,.08)'}}>
                  <div style={{fontWeight:700,fontSize:12,color:C.text,marginBottom:12,textTransform:'uppercase'}}>Composição</div>
                  <div style={{display:'flex',justifyContent:'center',marginBottom:12}}>
                    <Donut vals={[totSist,totEquip,totImpl].map(v=>v||0)} colors={[C.purple,C.teal,C.orange]} size={100} label={`${Math.round((totFat/Math.max(totGeral,1))*100)}%`} sub="fat."/>
                  </div>
                  {[{l:'Sistema',v:totSist,c:C.purple},{l:'Equipamento',v:totEquip,c:C.teal},{l:'Implantação',v:totImpl,c:C.orange}].map(x=>(
                    <div key={x.l} style={{display:'flex',alignItems:'center',gap:6,marginBottom:6}}>
                      <div style={{width:8,height:8,borderRadius:2,background:x.c}}/><span style={{flex:1,fontSize:11,color:C.textMuted}}>{x.l}</span><span style={{fontSize:11,fontWeight:700}}>{moeda(x.v)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{background:C.card,borderRadius:8,padding:'16px',boxShadow:'0 1px 3px rgba(0,0,0,.08)',marginBottom:14}}>
                <div style={{fontWeight:700,fontSize:12,color:C.text,marginBottom:12,textTransform:'uppercase'}}>Ranking financeiro</div>
                {porVend.map(({v,qtd,total,fat},rank)=>{const medals=['🥇','🥈','🥉'];
                  return <div key={v} onClick={()=>setFiltroVendedor(filtroVendedor===v?'Todos':v)} style={{display:'flex',alignItems:'center',gap:10,padding:'8px',borderRadius:8,marginBottom:4,cursor:'pointer',background:filtroVendedor===v?'#eff6ff':'#f8f9fa'}}>
                    <span style={{fontSize:18,width:22}}>{medals[rank]||'🎖'}</span>
                    <div style={{width:32,height:32,borderRadius:'50%',background:C.blue,display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontSize:12,fontWeight:700,flexShrink:0}}>{v[0]}</div>
                    <div style={{flex:1}}>
                      <div style={{display:'flex',justifyContent:'space-between',fontSize:12}}><span style={{fontWeight:600}}>{v}</span><span style={{fontWeight:700,color:C.green}}>{moeda(fat)}</span></div>
                      <div style={{fontSize:10,color:C.textMuted}}>{qtd} clientes • total {moeda(total)}</div>
                    </div>
                  </div>;
                })}
              </div>
              {agd.length>0&&(
                <div style={{background:C.card,borderRadius:8,boxShadow:'0 1px 3px rgba(0,0,0,.08)',border:`2px solid ${C.orange}`,overflow:'hidden'}}>
                  <div style={{background:'#fef9e7',padding:'10px 16px',borderBottom:`1px solid #fad7a0`,display:'flex',justifyContent:'space-between'}}>
                    <span style={{fontWeight:700,fontSize:12,color:C.orange,textTransform:'uppercase'}}>⏳ Aguardando faturamento</span>
                    <span style={{fontWeight:700,color:C.orange}}>{moeda(totAgd)}</span>
                  </div>
                  <table style={{width:'100%',borderCollapse:'collapse'}}>
                    <thead><tr style={{background:'#f8f9fa'}}>{['Empresa','Vendedor','Plano','Valor'].map(h=><th key={h} style={{padding:'7px 14px',textAlign:'left',fontSize:10,color:C.textMuted,fontWeight:700,textTransform:'uppercase'}}>{h}</th>)}</tr></thead>
                    <tbody>{sortRecente(agd).map((c,i)=>(
                      <tr key={c.id} onClick={()=>setClienteSel(c)} style={{borderTop:`1px solid ${C.border}`,cursor:'pointer',background:i%2===0?'#fff':'#fffef5'}}>
                        <td style={{padding:'8px 14px',fontSize:12,fontWeight:600,color:C.text,maxWidth:180,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{c.nome}</td>
                        <td style={{padding:'8px 14px',fontSize:11,color:C.textMuted}}>{c.vendedor}</td>
                        <td style={{padding:'8px 14px'}}><span style={{background:'#ebf5fb',color:C.blue,padding:'2px 7px',borderRadius:10,fontSize:10,fontWeight:700}}>{c.plano}</span></td>
                        <td style={{padding:'8px 14px',fontSize:12,fontWeight:700,color:C.orange}}>{moeda(c.total)}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ASAAS */}
          {!clienteSel&&page==='asaas'&&<AsaasView todos={todos} clientes={clientes} perfil={perfil} onAtualizarCliente={async(id,dados)=>atualizarCliente(id,dados)}/>}

          {/* RELATÓRIOS */}
          {!clienteSel&&page==='relatorios'&&<RelatoriosView todos={todos} implantacoes={implantacoes}/>}

          {/* ORÇAMENTOS */}
          {!clienteSel&&page==='orcamentos'&&<OrcamentosView
            orcamentos={orcamentos} orcServicos={orcServicos} orcFormas={orcFormas}
            orcTemplates={orcTemplates} equipamentosCad={equipamentosCad}
            vendedoresCad={vendedoresCad}
            currentUser={userProfile}
            onImportarCRM={dados=>{setDadosImportados(dados);setPage('novo');}}
          />}

          {/* SOLICITAÇÕES */}
          {!clienteSel&&page==='solicitacoes'&&<SolicitacoesView solicitacoes={solicitacoes} usuarios={usuarios} todos={todos} currentUser={userProfile}/>}

          {/* CLIENTES */}
          {!clienteSel&&page==='clientes'&&(
            <div>
              <div style={{background:C.card,borderRadius:8,boxShadow:'0 1px 3px rgba(0,0,0,.08)',overflow:'hidden'}}>
                <div style={{padding:'12px 16px',borderBottom:`1px solid ${C.border}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <span style={{fontWeight:700,fontSize:13,color:C.text}}>{cl.length} clientes</span>
                  {perfil!=='financeiro'&&<button onClick={()=>setPage('novo')} style={{background:C.blue,color:'#fff',border:'none',borderRadius:5,padding:'6px 14px',cursor:'pointer',fontSize:12,fontWeight:700,display:'flex',alignItems:'center',gap:6}}><i className="ti ti-plus"/>Novo cliente</button>}
                </div>
                <table style={{width:'100%',borderCollapse:'collapse'}}>
                  <thead><tr style={{background:'#f8f9fa'}}>
                    {['Empresa','CNPJ','Contato','Plano','Vendedor','Status','Asaas','Total'].map(h=><th key={h} style={{padding:'8px 12px',textAlign:'left',fontSize:10,color:C.textMuted,fontWeight:700,textTransform:'uppercase'}}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {sortRecente(cl).slice(0,200).map((c,i)=>(
                      <tr key={c.id} onClick={()=>setClienteSel(c)} style={{borderTop:`1px solid ${C.border}`,cursor:'pointer',background:i%2===0?'#fff':'#fdfdfd'}}>
                        <td style={{padding:'8px 12px',fontSize:12,fontWeight:600,color:C.text,maxWidth:160,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                          {!c._base&&<span style={{background:'#d5f5e3',color:C.green,fontSize:9,padding:'1px 4px',borderRadius:3,marginRight:4}}>novo</span>}{c.nome}
                        </td>
                        <td style={{padding:'8px 12px',fontSize:11,color:C.textMuted}}>{c.cnpj}</td>
                        <td style={{padding:'8px 12px',fontSize:11,color:C.textMuted}}>{c.contato}</td>
                        <td style={{padding:'8px 12px'}}>{c.plano!=='—'&&<span style={{background:'#ebf5fb',color:C.blue,padding:'2px 7px',borderRadius:10,fontSize:10,fontWeight:700}}>{c.plano}</span>}</td>
                        <td style={{padding:'8px 12px',fontSize:11,color:C.textMuted}}>{c.vendedor}</td>
                        <td style={{padding:'8px 12px'}}><span style={{background:c.status==='Faturado'?'#d5f5e3':'#fef9e7',color:c.status==='Faturado'?C.green:C.orange,padding:'2px 8px',borderRadius:10,fontSize:10,fontWeight:700}}>{c.status==='Faturado'?'✓ Fat.':'⏳ Agd.'}</span></td>
                        <td style={{padding:'8px 12px'}}>{!c._base&&<AsaasBadge status={c.asaas_status||'SEM_FATURAMENTO'} size="small"/>}</td>
                        <td style={{padding:'8px 12px',fontSize:12,fontWeight:700,color:C.blue}}>{moeda(c.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {cl.length>200&&<div style={{padding:'10px',textAlign:'center',fontSize:11,color:C.textMuted}}>Mostrando 200 de {cl.length}. Use filtros.</div>}
              </div>
            </div>
          )}

        </div>
      </div>

      {/* WIDGET FINANCEIRO IA FLUTUANTE */}
      {(perfil==='financeiro'||perfil==='admin')&&(
        <WidgetFinanceiro currentUser={userProfile} clientes={clientes} todos={todos}/>
      )}
    </div>
  );
}
