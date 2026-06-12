import { useState, useEffect, useMemo } from "react";
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

// ─── CONSTANTES ──────────────────────────────────────────────────────────────
const MESES=["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
const PLANOS=['Basic','Pro','Ultimate'];
const FORMAS=['Boleto','Pix','Cartão de crédito','Link de pagamento','A vista','Transferência','Dinheiro','Outro'];
const EQUIPS=['Evo40','Tablet','Celular','Control ID','TopData InnerRep','Já possui','Nenhum','Outro'];
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
  {id:'dashboard',   icon:'ti-layout-dashboard', label:'Dashboard',    perfis:['admin','financeiro','colaborador']},
  {id:'vendas',      icon:'ti-chart-bar',         label:'Vendas',       perfis:['admin','financeiro']},
  {id:'financeiro',  icon:'ti-currency-dollar',   label:'Financeiro',   perfis:['admin','financeiro']},
  {id:'clientes',    icon:'ti-users',             label:'Clientes',     perfis:['admin','colaborador']},
  {id:'novo',        icon:'ti-plus',              label:'Novo cliente', perfis:['admin','colaborador']},
  {id:'implantacao', icon:'ti-rocket',            label:'Implantação',  perfis:['admin','colaborador']},
  {id:'relatorios',  icon:'ti-file-spreadsheet',  label:'Relatórios',   perfis:['admin','financeiro']},
];
// Config sempre fixo no final, só admin
const NAV_CONFIG={id:'config',icon:'ti-settings',label:'Configurações',perfis:['admin']};
function getNavItems(order){
  const base=NAV_ITEMS_BASE.slice();
  if(!order||!order.length)return[...base,NAV_CONFIG];
  const sorted=[...order.map(id=>base.find(n=>n.id===id)).filter(Boolean),...base.filter(n=>!order.includes(n.id))];
  return[...sorted,NAV_CONFIG];
}
const NAV_ITEMS=getNavItems(null);
const C={
  sidebar:'#2c3e50',sidebarActive:'#3498db',
  header:'#34495e',
  blue:'#3498db',green:'#27ae60',orange:'#e67e22',red:'#e74c3c',
  purple:'#9b59b6',teal:'#1abc9c',
  bg:'#ecf0f1',card:'#fff',text:'#2c3e50',textMuted:'#7f8c8d',border:'#dde1e7'
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────
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


// ─── EXPORT EXCEL/CSV ────────────────────────────────────────────────────────
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

// ─── GRÁFICO MRR MENSAL ──────────────────────────────────────────────────────
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

// ─── PAINEL DE ALERTAS ───────────────────────────────────────────────────────
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

// ─── META MENSAL ─────────────────────────────────────────────────────────────
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

// ─── PÁGINA DE RELATÓRIOS ─────────────────────────────────────────────────────
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
              {dadosFiltrados.slice(0,300).map((c,i)=>(
                <tr key={c.id} style={{borderTop:'1px solid '+C.border,background:i%2===0?'#fff':'#fdfdfd'}}>
                  <td style={{padding:'7px 10px',fontSize:11,fontWeight:600,color:C.text,maxWidth:160,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{c.nome}</td>
                  <td style={{padding:'7px 10px',fontSize:10,color:C.textMuted,whiteSpace:'nowrap'}}>{c.cnpj}</td>
                  <td style={{padding:'7px 10px'}}><span style={{background:'#ebf5fb',color:C.blue,padding:'1px 6px',borderRadius:8,fontSize:10,fontWeight:700}}>{c.plano}</span></td>
                  <td style={{padding:'7px 10px',fontSize:11,color:C.textMuted}}>{c.vendedor}</td>
                  <td style={{padding:'7px 10px'}}><span style={{background:c.status==='Faturado'?'#d5f5e3':'#fef9e7',color:c.status==='Faturado'?C.green:C.orange,padding:'1px 7px',borderRadius:8,fontSize:10,fontWeight:700}}>{c.status==='Faturado'?'✓ Fat.':'⏳ Agd.'}</span></td>
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

// ─── CSV BASE (dados históricos da planilha) ──────────────────────────────────
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

// ─── TELA DE LOGIN ────────────────────────────────────────────────────────────
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
          <div style={{fontSize:32,marginBottom:8}}>🕐</div>
          <div style={{fontWeight:700,fontSize:20,color:'#2c3e50'}}>Secullum CRM</div>
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

// ─── COMPONENTES VISUAIS ──────────────────────────────────────────────────────
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

// ─── CARD DETALHE (IMPLANTAÇÃO) ───────────────────────────────────────────────
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

// ─── KANBAN VIEW ──────────────────────────────────────────────────────────────
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
                      return(
                        <div key={c.id}
                          draggable
                          onDragStart={e=>{setDragId(c.id);e.dataTransfer.effectAllowed='move';}}
                          onDragEnd={()=>{setDragId(null);setDragOver(null);}}
                          onClick={()=>setClienteKanban(c)}
                          style={{background:'#fff',borderRadius:6,padding:'10px',cursor:'grab',boxShadow:dragId===c.id?'0 4px 12px rgba(0,0,0,.2)':'0 1px 3px rgba(0,0,0,.08)',borderLeft:`3px solid ${etapa.color}`,opacity:dragId===c.id?.5:1}}>
                          <div style={{fontSize:11,fontWeight:700,color:'#2c3e50',marginBottom:3,lineHeight:1.3}}>{c.nome}</div>
                          {c.vendedor!=='—'&&<div style={{fontSize:10,color:'#7f8c8d',marginBottom:2}}>👤 {c.vendedor}</div>}
                          {c.impl.prazo&&<div style={{fontSize:10,color:atrasado?'#e74c3c':'#27ae60',fontWeight:600}}>📅 {new Date(c.impl.prazo+'T12:00:00').toLocaleDateString('pt-BR')}{atrasado?' ⚠':''}</div>}
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

// ─── FORMULÁRIO NOVO CLIENTE ──────────────────────────────────────────────────
function NovoForm({onSave,onCancel,vendedoresCad,equipamentosCad}){
  const hoje=new Date();
  const equipDefault=equipamentosCad.length>0?equipamentosCad[0].nome:'Evo40';
  const [f,setF]=useState({data:`${(hoje.getMonth()+1).toString().padStart(2,'0')}/${hoje.getDate().toString().padStart(2,'0')}/${hoje.getFullYear()}`,nome:'',cnpj:'',contato:'',tel:'',func:'',equipTipo:equipDefault,vI:'',vE:'',vS:'',pagamento:'Boleto',dtBoleto:'',email:'',status:'Faturado',plano:'Basic',vendedor:'',nfe:'Não',renovacao:'',obs:'',equipPago:'Não se aplica',equipRastreio:'',equipDataEnvio:''});
  const up=(k,v)=>setF(x=>({...x,[k]:v}));
  const tot=(parseValor(f.vI)||0)+(parseValor(f.vE)||0)+(parseValor(f.vS)||0);
  const equipSel=equipamentosCad.find(e=>e.nome===f.equipTipo);
  const requerPag=equipSel?equipSel.requerPagamento:false;

  const [erros,setErros]=useState({});
  function validar(){
    const e={};
    if(!f.nome.trim())e.nome='Obrigatório';
    if(!f.cnpj.trim())e.cnpj='Obrigatório';
    if(!f.tel.trim())e.tel='Obrigatório';
    if(!f.email.trim())e.email='Obrigatório';
    if(!f.plano)e.plano='Obrigatório';
    if(!f.equipTipo)e.equipTipo='Obrigatório';
    if(!f.vS&&parseValor(f.vS)===0)e.vS='Informe o valor';
    setErros(e);
    return Object.keys(e).length===0;
  }
  function salvar(){
    if(!validar())return;
    const d=parseDate(f.data);
    const vI=parseValor(f.vI),vE=parseValor(f.vE),vS=parseValor(f.vS);
    onSave({_base:false,data:d,ano:d?d.getFullYear():null,mes:d?d.getMonth():null,nome:f.nome.trim().toUpperCase(),cnpj:f.cnpj.trim().toUpperCase(),contato:f.contato.trim().toUpperCase(),tel:f.tel.trim().toUpperCase(),func:parseInt(f.func)||0,equipTipo:f.equipTipo,vI,vE,vS,total:vI+vE+vS,pagamento:f.pagamento,dtBoleto:f.dtBoleto,email:f.email.trim(),status:f.status,plano:f.plano,vendedor:f.vendedor||'—',nfe:f.nfe,renovacao:f.renovacao,obs:f.obs,equipPago:requerPag?f.equipPago:'Não se aplica',equipRastreio:f.equipRastreio.trim(),equipDataEnvio:f.equipDataEnvio});
  }
  const fi={padding:'7px 10px',borderRadius:5,border:'1px solid #dde1e7',fontSize:13,color:'#2c3e50',background:'#fff',width:'100%',boxSizing:'border-box'};
  const fiErr=(k)=>({...fi,border:erros[k]?'1px solid #e74c3c':'1px solid #dde1e7',background:erros[k]?'#fff5f5':'#fff'});
  const lbl={fontSize:11,color:'#7f8c8d',display:'block',marginBottom:3,fontWeight:700,textTransform:'uppercase',letterSpacing:.4};
  const lblReq=(k)=>(<label style={{...lbl,color:erros[k]?'#e74c3c':'#7f8c8d'}}>{erros[k]?'* '+erros[k]:lbl}</label>);
  const sec={background:C.card,borderRadius:8,padding:'16px',marginBottom:12,boxShadow:'0 1px 3px rgba(0,0,0,.06)'};
  const listaVendedores=vendedoresCad.length>0?vendedoresCad.map(v=>v.nome):[...new Set(CLIENTES_BASE.map(c=>c.vendedor).filter(v=>v&&v!=='—'))].sort();
  const listaEquips=equipamentosCad.length>0?equipamentosCad.map(e=>e.nome):EQUIPS;

  return(
    <div style={{fontFamily:'sans-serif'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
        <div style={{fontWeight:700,fontSize:16,color:C.text}}>Novo cliente</div>
        <button onClick={onCancel} style={{background:'none',border:'none',cursor:'pointer',color:C.textMuted,fontSize:13}}>← Voltar</button>
      </div>
      <div style={sec}>
        <div style={{fontWeight:700,fontSize:12,color:'#3498db',marginBottom:12,textTransform:'uppercase'}}>Dados da empresa</div>
        <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:10,marginBottom:10}}>
          <div><label style={{...lbl,color:erros.nome?'#e74c3c':'#7f8c8d'}}>{erros.nome?'Nome — '+erros.nome:'Nome *'}</label><input style={fiErr('nome')} value={f.nome} onChange={e=>up('nome',e.target.value.toUpperCase())} style={{...fi,textTransform:'uppercase'}}/></div>
          <div><label style={lbl}>Data (MM/DD/AAAA)</label><input style={fi} value={f.data} onChange={e=>up('data',e.target.value)}/></div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
          <div><label style={{...lbl,color:erros.cnpj?'#e74c3c':'#7f8c8d'}}>{erros.cnpj?'CNPJ/CPF — '+erros.cnpj:'CNPJ/CPF *'}</label><input style={fiErr('cnpj')} value={f.cnpj} onChange={e=>up('cnpj',e.target.value.toUpperCase())} style={{...fi,textTransform:'uppercase'}}/></div>
          <div><label style={{...lbl,color:erros.email?'#e74c3c':'#7f8c8d'}}>{erros.email?'Email — '+erros.email:'Email financeiro *'}</label><input style={fiErr('email')} type="email" value={f.email} onChange={e=>up('email',e.target.value)}/></div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10}}>
          <div><label style={lbl}>Contato</label><input style={fi} value={f.contato} onChange={e=>up('contato',e.target.value.toUpperCase())} style={{...fi,textTransform:'uppercase'}}/></div>
          <div><label style={{...lbl,color:erros.tel?'#e74c3c':'#7f8c8d'}}>{erros.tel?'Telefone — '+erros.tel:'Telefone *'}</label><input style={fiErr('tel')} value={f.tel} onChange={e=>up('tel',e.target.value.toUpperCase())} style={{...fi,textTransform:'uppercase'}}/></div>
          <div><label style={lbl}>Funcionários</label><input style={fi} type="number" value={f.func} onChange={e=>up('func',e.target.value)}/></div>
        </div>
      </div>
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
          <div><label style={lbl}>Implantação (R$)</label><input style={fi} type="number" step="0.01" value={f.vI} onChange={e=>up('vI',e.target.value)}/></div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
          <div><label style={lbl}>Equipamento (R$)</label><input style={fi} type="number" step="0.01" value={f.vE} onChange={e=>up('vE',e.target.value)}/></div>
          <div><label style={{...lbl,color:erros.vS?'#e74c3c':'#7f8c8d'}}>{erros.vS?'Sistema/mês — '+erros.vS:'Sistema/mês (R$) *'}</label><input style={fiErr('vS')} type="number" step="0.01" value={f.vS} onChange={e=>up('vS',e.target.value)}/></div>
        </div>
        {/* Pagamento do equipamento */}
        {requerPag&&(
          <div style={{background:'#fffbeb',border:'1px solid #fde68a',borderRadius:6,padding:'12px',marginBottom:10}}>
            <div style={{fontWeight:700,fontSize:11,color:C.orange,marginBottom:8,textTransform:'uppercase'}}>📦 Pagamento do equipamento</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10}}>
              <div><label style={lbl}>Status do pagamento</label>
                <select style={fi} value={f.equipPago} onChange={e=>up('equipPago',e.target.value)}>
                  <option value="Não pago">❌ Não pago</option>
                  <option value="Pago">✅ Pago</option>
                  <option value="Não se aplica">— Não se aplica</option>
                </select>
              </div>
              {f.equipPago==='Pago'&&<>
                <div><label style={lbl}>Nº rastreio (Sedex)</label><input style={fi} value={f.equipRastreio} onChange={e=>up('equipRastreio',e.target.value)} placeholder="XX000000000BR"/></div>
                <div><label style={lbl}>Data de envio</label><input style={fi} type="date" value={f.equipDataEnvio} onChange={e=>up('equipDataEnvio',e.target.value)}/></div>
              </>}
            </div>
          </div>
        )}
        <div style={{background:'#ebf5fb',borderRadius:6,padding:'10px 14px',display:'flex',justifyContent:'space-between'}}>
          <span style={{fontSize:13,color:C.textMuted,fontWeight:600}}>TOTAL</span>
          <span style={{fontSize:18,fontWeight:700,color:'#3498db'}}>{moeda(tot)}</span>
        </div>
      </div>
      <div style={sec}>
        <div style={{fontWeight:700,fontSize:12,color:'#27ae60',marginBottom:12,textTransform:'uppercase'}}>Contrato</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
          <div><label style={lbl}>Forma pagamento</label><select style={fi} value={f.pagamento} onChange={e=>up('pagamento',e.target.value)}>{FORMAS.map(x=><option key={x}>{x}</option>)}</select></div>
          <div><label style={lbl}>Data 1º boleto</label><input style={fi} value={f.dtBoleto} onChange={e=>up('dtBoleto',e.target.value)} placeholder="DD/MM/AAAA"/></div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:10,marginBottom:10}}>
          <div><label style={{...lbl,color:erros.plano?'#e74c3c':'#7f8c8d'}}>{erros.plano?'Plano — '+erros.plano:'Plano *'}</label>
            <select style={fiErr('plano')} value={f.plano} onChange={e=>up('plano',e.target.value)}>{PLANOS.map(p=><option key={p}>{p}</option>)}</select></div>
          <div><label style={lbl}>Vendedor</label>
            <select style={fi} value={f.vendedor} onChange={e=>up('vendedor',e.target.value)}>
              <option value="">— Selecione —</option>
              {listaVendedores.map(v=><option key={v}>{v}</option>)}
            </select>
          </div>
          <div><label style={lbl}>Status</label><select style={fi} value={f.status} onChange={e=>up('status',e.target.value)}><option value="Faturado">Faturado</option><option value="Aguardando">Aguardando</option></select></div>
          <div><label style={lbl}>Emitir NFE</label><select style={fi} value={f.nfe} onChange={e=>up('nfe',e.target.value)}><option>Sim</option><option>Não</option></select></div>
        </div>
        <div><label style={lbl}>Observações</label><textarea style={{...fi,resize:'vertical',minHeight:56}} value={f.obs} onChange={e=>up('obs',e.target.value.toUpperCase())} style={{...fi,resize:'vertical',minHeight:56,textTransform:'uppercase'}}/></div>
      </div>
      <button onClick={salvar} style={{width:'100%',padding:'12px',borderRadius:6,border:'none',background:'#3498db',color:'#fff',fontWeight:700,cursor:'pointer',fontSize:14,display:'flex',alignItems:'center',justifyContent:'center',gap:8}}>
        <i className="ti ti-device-floppy"/> Salvar cliente
      </button>
    </div>
  );
}

// ─── DETALHE CLIENTE ──────────────────────────────────────────────────────────
function DetalheCliente({c,onVoltar,onUpdate,vendedoresCad,equipamentosCad}){
  const [editMode,setEditMode]=useState(false);
  const [saved,setSaved]=useState(false);
  const [f,setF]=useState({
    nome:c.nome||'',
    cnpj:c.cnpj||'',
    contato:c.contato||'',
    tel:c.tel||'',
    email:c.email||'',
    func:c.func!=null?String(c.func):'',
    equipTipo:c.equipTipo||'Evo40',
    vI:c.vI!=null?String(c.vI):'',
    vE:c.vE!=null?String(c.vE):'',
    vS:c.vS!=null?String(c.vS):'',
    pagamento:c.pagamento||'Boleto',
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
  function Campo({label,field,type='text',opts,span}){
    const upperTypes=['text'];
    const shouldUpper=upperTypes.includes(type)&&!opts&&field!=='email'&&field!=='equipRastreio';
    return(
      <div style={span?{gridColumn:`span ${span}`}:{}}>
        <label style={lbl}>{label}</label>
        {editMode
          ? opts
            ? <select style={fi} value={f[field]} onChange={e=>up(field,e.target.value)}>
                {opts.map(o=>typeof o==='object'
                  ?<option key={o.v} value={o.v}>{o.l}</option>
                  :<option key={o}>{o}</option>)}
              </select>
            : type==='textarea'
              ? <textarea style={{...fi,resize:'vertical',minHeight:60,textTransform:'uppercase'}} value={f[field]} onChange={e=>up(field,e.target.value.toUpperCase())}/>
              : <input style={{...fi,textTransform:shouldUpper?'uppercase':'none'}} type={type} step={type==='number'?'0.01':undefined} value={f[field]} onChange={e=>up(field,shouldUpper?e.target.value.toUpperCase():e.target.value)}/>
          : <div style={fiView}>{f[field]||'—'}</div>
        }
      </div>
    );
  }

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
            <span style={{background:f.status==='Faturado'?'#d5f5e3':'#fef9e7',color:f.status==='Faturado'?C.green:C.orange,padding:'2px 10px',borderRadius:20,fontSize:11,fontWeight:700}}>
              {f.status==='Faturado'?'✓ Faturado':'⏳ Aguardando'}
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
                : <div style={{fontSize:15,fontWeight:700}}>{moeda(c[k])}</div>
              }
            </div>
          ))}
        </div>
      </div>

      {/* Dados da empresa */}
      <div style={sec}>
        <div style={{fontWeight:700,fontSize:12,color:C.blue,marginBottom:12,textTransform:'uppercase'}}>Dados da empresa</div>
        <div style={{display:'grid',gridTemplateColumns:'2fr 1fr',gap:10,marginBottom:10}}>
          <Campo label="Nome *" field="nome"/>
          <Campo label="CNPJ/CPF" field="cnpj"/>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10,marginBottom:10}}>
          <Campo label="Contato" field="contato"/>
          <Campo label="Telefone" field="tel"/>
          <Campo label="Email financeiro" field="email" type="email"/>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
          <Campo label="Funcionários" field="func" type="number"/>
          <Campo label="Equipamento" field="equipTipo" opts={equipamentosCad.length>0?equipamentosCad.map(e=>e.nome):EQUIPS}/>
        </div>
      </div>

      {/* Contrato */}
      <div style={sec}>
        <div style={{fontWeight:700,fontSize:12,color:C.green,marginBottom:12,textTransform:'uppercase'}}>Contrato</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:10,marginBottom:10}}>
          <Campo label="Plano" field="plano" opts={PLANOS}/>
          <Campo label="Vendedor" field="vendedor" opts={vendedoresCad.length>0?['—',...vendedoresCad.map(v=>v.nome)]:null}/>
          <Campo label="Status" field="status" opts={[{v:'Faturado',l:'✓ Faturado'},{v:'Aguardando',l:'⏳ Aguardando'}]}/>
          <Campo label="Emitir NF-e" field="nfe" opts={['Sim','Não']}/>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
          <Campo label="Forma de pagamento" field="pagamento" opts={FORMAS}/>
          <Campo label="Data 1º boleto" field="dtBoleto"/>
        </div>
        <Campo label="Observações" field="obs" type="textarea" span={2}/>
      </div>

      {/* Pagamento do equipamento */}
      {(()=>{
        const equipSel=(equipamentosCad||[]).find(e=>e.nome===f.equipTipo);
        const requerPag=equipSel?equipSel.requerPagamento:(f.equipPago&&f.equipPago!=='Não se aplica');
        if(!requerPag&&f.equipPago==='Não se aplica')return null;
        return(
          <div style={{...sec,borderLeft:`4px solid ${C.orange}`}}>
            <div style={{fontWeight:700,fontSize:12,color:C.orange,marginBottom:12,textTransform:'uppercase'}}>📦 Pagamento do equipamento</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10}}>
              <div>
                <label style={lbl}>Status</label>
                {editMode
                  ?<select style={fi} value={f.equipPago} onChange={e=>up('equipPago',e.target.value)}>
                    <option value="Não pago">❌ Não pago</option>
                    <option value="Pago">✅ Pago</option>
                    <option value="Não se aplica">— Não se aplica</option>
                  </select>
                  :<div style={{...fiView,fontWeight:700,color:f.equipPago==='Pago'?C.green:f.equipPago==='Não pago'?C.red:C.textMuted}}>
                    {f.equipPago==='Pago'?'✅ Pago':f.equipPago==='Não pago'?'❌ Não pago':'— Não se aplica'}
                  </div>
                }
              </div>
              <div>
                <label style={lbl}>Nº rastreio (Sedex)</label>
                {editMode
                  ?<input style={fi} value={f.equipRastreio} onChange={e=>up('equipRastreio',e.target.value)} placeholder="XX000000000BR"/>
                  :<div style={{...fiView,fontFamily:'monospace',letterSpacing:1}}>{f.equipRastreio||'—'}</div>
                }
              </div>
              <div>
                <label style={lbl}>Data de envio</label>
                {editMode
                  ?<input style={fi} type="date" value={f.equipDataEnvio} onChange={e=>up('equipDataEnvio',e.target.value)}/>
                  :<div style={fiView}>{f.equipDataEnvio?new Date(f.equipDataEnvio+'T12:00:00').toLocaleDateString('pt-BR'):'—'}</div>
                }
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ─── CONFIGURAÇÕES ────────────────────────────────────────────────────────────
function ConfigView({usuarios,currentUser,vendedoresCad,equipamentosCad,menuOrder,onMenuOrderChange}){
  const [novoVend,setNovoVend]=useState('');
  const [savedVend,setSavedVend]=useState(false);
  const [novoEquip,setNovoEquip]=useState({nome:'',requerPagamento:true});
  const [savedEquip,setSavedEquip]=useState(false);
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
    try{localStorage.setItem('crm_menu_order',JSON.stringify(localOrder));}catch(e){}
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
            <div key={e.id} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 12px',borderRadius:6,background:'#f8f9fa',marginBottom:6}}>
              <i className="ti ti-device-laptop" style={{color:C.teal,fontSize:15}}/>
              <span style={{flex:1,fontSize:12,fontWeight:600,color:C.text}}>{e.nome}</span>
              <span style={{fontSize:10,padding:'2px 8px',borderRadius:10,fontWeight:700,background:e.requerPagamento?'#fef9e7':'#d5f5e3',color:e.requerPagamento?C.orange:C.green}}>{e.requerPagamento?'Requer pagamento':'Sem custo'}</span>
              <button onClick={()=>removeEquipamento(e.id)} style={{background:'none',border:'none',cursor:'pointer',color:'#e74c3c',fontSize:14}}>×</button>
            </div>
          ))}
          {equipamentosCad.length===0&&<div style={{fontSize:12,color:C.textMuted,textAlign:'center',padding:'8px 0'}}>Nenhum equipamento cadastrado.</div>}
        </div>
        <div style={{display:'flex',gap:8,alignItems:'flex-end'}}>
          <div style={{flex:1}}><label style={lbl}>Nome do equipamento</label><input style={{...fi,textTransform:'uppercase'}} value={novoEquip.nome} onChange={e=>setNovoEquip(x=>({...x,nome:e.target.value.toUpperCase()}))} onKeyDown={e=>e.key==='Enter'&&addEquipamento()} placeholder="EX: EVO40, TABLET..."/></div>
          <div><label style={lbl}>Requer pagamento?</label>
            <select style={fi} value={String(novoEquip.requerPagamento)} onChange={e=>setNovoEquip(x=>({...x,requerPagamento:e.target.value==='true'}))}>
              <option value="true">Sim — cliente paga</option>
              <option value="false">Não — sem custo</option>
            </select>
          </div>
          <button onClick={addEquipamento} style={{padding:'7px 16px',borderRadius:5,border:'none',background:savedEquip?C.green:C.teal,color:'#fff',fontWeight:700,cursor:'pointer',fontSize:12,whiteSpace:'nowrap',height:36}}>
            {savedEquip?'✓ Adicionado!':'+ Adicionar'}
          </button>
        </div>
      </div>

      {/* Ordenação do menu */}
      <div style={sec}>
        <div style={{fontWeight:700,fontSize:12,color:C.purple,marginBottom:4,textTransform:'uppercase'}}>Ordem do menu</div>
        <div style={{fontSize:11,color:C.textMuted,marginBottom:12}}>Arraste os itens para reordenar. Configurações é sempre o último item.</div>
        <div style={{marginBottom:12}}>
          {localOrder.map(id=>{
            const item=NAV_ITEMS_BASE.find(n=>n.id===id);
            if(!item)return null;
            return(
              <div key={id} draggable onDragStart={()=>onDragStart(id)} onDragOver={e=>onDragOver(e,id)} onDrop={()=>onDrop(id)} onDragEnd={()=>{setDragMenuId(null);setDragOverId(null);}}
                style={{display:'flex',alignItems:'center',gap:10,padding:'9px 12px',borderRadius:6,background:dragOverId===id?'#ebf5fb':'#f8f9fa',marginBottom:5,cursor:'grab',border:dragOverId===id?'1px dashed #3498db':'1px solid transparent',transition:'background .15s'}}>
                <i className="ti ti-grip-vertical" style={{color:C.textMuted,fontSize:16}}/>
                <i className={`ti ${item.icon}`} style={{color:C.blue,fontSize:15}}/>
                <span style={{fontSize:12,fontWeight:600,color:C.text,flex:1}}>{item.label}</span>
              </div>
            );
          })}
          {/* Config sempre fixo */}
          <div style={{display:'flex',alignItems:'center',gap:10,padding:'9px 12px',borderRadius:6,background:'#f8f9fa',marginBottom:5,opacity:.5,border:'1px solid #dde1e7'}}>
            <i className="ti ti-lock" style={{color:C.textMuted,fontSize:14}}/>
            <i className="ti ti-settings" style={{color:C.textMuted,fontSize:15}}/>
            <span style={{fontSize:12,fontWeight:600,color:C.textMuted,flex:1}}>Configurações — fixo</span>
          </div>
        </div>
        <button onClick={salvarOrdemMenu} style={{padding:'8px 18px',borderRadius:6,border:'none',background:C.purple,color:'#fff',fontWeight:700,cursor:'pointer',fontSize:12,display:'flex',alignItems:'center',gap:6}}>
          <i className="ti ti-device-floppy"/> Salvar ordem
        </button>
      </div>

    </div>
  );
}

// ─── APP PRINCIPAL ────────────────────────────────────────────────────────────
export default function App(){
  const [authUser,setAuthUser]=useState(null);
  const [authLoading,setAuthLoading]=useState(true);
  const [userProfile,setUserProfile]=useState(null);
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
  const [menuOrder,setMenuOrder]=useState(()=>{try{const s=localStorage.getItem('crm_menu_order');return s?JSON.parse(s):null;}catch(e){return null;}});
  const [metaSistema,setMetaSistema]=useState(()=>{try{return parseFloat(localStorage.getItem('crm_meta_sistema'))||0;}catch(e){return 0;}});
  const [metaEquip,setMetaEquip]=useState(()=>{try{return parseFloat(localStorage.getItem('crm_meta_equip'))||0;}catch(e){return 0;}});
  function salvarMetaSistema(v){setMetaSistema(v);try{localStorage.setItem('crm_meta_sistema',String(v));}catch(e){}}
  function salvarMetaEquip(v){setMetaEquip(v);try{localStorage.setItem('crm_meta_equip',String(v));}catch(e){}}

  // Auth listener
  useEffect(()=>{
    return onAuthStateChanged(auth,async user=>{
      setAuthUser(user);
      if(user){
        try{
          const snap=await getDocs(collection(db,'usuarios'));
          const perfis={};
          snap.forEach(d=>perfis[d.id]={id:d.id,...d.data()});
          setUserProfile(perfis[user.uid]||{email:user.email,perfil:'admin',nome:user.email});
          setUsuarios(Object.values(perfis));
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
  const filtroAtivo=busca||filtroAno!=='Todos'||filtroMes!=='Todos'||filtroVendedor!=='Todos'||filtroPlano!=='Todos'||filtroStatus!=='Todos';

  return(
    <div style={{display:'flex',minHeight:'100vh',fontFamily:"'Segoe UI',sans-serif",background:C.bg,fontSize:13}}>

      {/* SIDEBAR */}
      <div style={{width:200,background:C.sidebar,flexShrink:0,display:'flex',flexDirection:'column'}}>
        <div style={{padding:'18px 16px',borderBottom:'1px solid rgba(255,255,255,.08)'}}>
          <div style={{color:'#fff',fontWeight:700,fontSize:15,display:'flex',alignItems:'center',gap:8}}>
            <i className="ti ti-clock-record" style={{fontSize:18,color:C.blue}}/>Secullum CRM
          </div>
          <div style={{color:'#7f8c8d',fontSize:10,marginTop:2}}>{todos.length} clientes</div>
        </div>
        <div style={{padding:'12px 8px',flex:1}}>
          <div style={{fontSize:9,color:'#7f8c8d',fontWeight:700,textTransform:'uppercase',letterSpacing:1,padding:'0 8px',marginBottom:8}}>Menu</div>
          {navItems.map(n=>(
            <div key={n.id} onClick={()=>{setPage(n.id);setClienteSel(null);}} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 16px',borderRadius:6,cursor:'pointer',background:page===n.id?C.sidebarActive:'transparent',color:page===n.id?'#fff':'#bdc3c7',marginBottom:2,fontSize:13,fontWeight:page===n.id?600:400}}>
              <i className={`ti ${n.icon}`} style={{fontSize:16}}/>
              <span>{n.label}</span>
            </div>
          ))}
        </div>
        <div style={{padding:'12px 16px',borderTop:'1px solid rgba(255,255,255,.08)'}}>
          <div style={{color:'#7f8c8d',fontSize:10,marginBottom:6}}>{userProfile?.email}</div>
          <button onClick={()=>signOut(auth)} style={{background:'rgba(255,255,255,.1)',border:'none',borderRadius:5,padding:'5px 10px',color:'#bdc3c7',cursor:'pointer',fontSize:11,width:'100%'}}>
            <i className="ti ti-logout" style={{marginRight:4}}/>Sair
          </button>
        </div>
      </div>

      {/* MAIN */}
      <div style={{flex:1,display:'flex',flexDirection:'column',minWidth:0}}>
        <div style={{background:C.header,padding:'10px 20px',display:'flex',alignItems:'center',justifyContent:'space-between',boxShadow:'0 1px 4px rgba(0,0,0,.15)'}}>
          <div style={{color:'#fff',fontWeight:600,fontSize:14,display:'flex',alignItems:'center',gap:8}}>
            <i className={`ti ${navItems.find(n=>n.id===page)?.icon||'ti-layout-dashboard'}`} style={{color:C.blue}}/>
            {navItems.find(n=>n.id===page)?.label||'Dashboard'}
          </div>
          <div style={{display:'flex',alignItems:'center',gap:12}}>
            <div style={{position:'relative'}}>
              <i className="ti ti-search" style={{position:'absolute',left:8,top:'50%',transform:'translateY(-50%)',color:'#bdc3c7',fontSize:14}}/>
              <input value={busca} onChange={e=>setBusca(e.target.value)} placeholder="Buscar cliente..." style={{...fi,paddingLeft:28,width:180,background:'rgba(255,255,255,.1)',border:'none',color:'#fff'}}/>
            </div>
            <div style={{width:32,height:32,borderRadius:'50%',background:C.blue,display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontWeight:700,fontSize:13}}>{(userProfile?.email||'A')[0].toUpperCase()}</div>
          </div>
        </div>

        <div style={{flex:1,overflowY:'auto',padding:'20px'}}>
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
          {page==='novo'&&<NovoForm onSave={async d=>{await salvarCliente(d);setPage('clientes');}} onCancel={()=>setPage('clientes')} vendedoresCad={vendedoresCad} equipamentosCad={equipamentosCad}/>}

          {/* DETALHE */}
          {clienteSel&&page!=='novo'&&<DetalheCliente c={clienteSel} onVoltar={()=>setClienteSel(null)} onUpdate={async u=>{await atualizarCliente(u.id,u);}} vendedoresCad={vendedoresCad} equipamentosCad={equipamentosCad}/>}

          {/* IMPLANTAÇÃO */}
          {!clienteSel&&page==='implantacao'&&<KanbanView todos={todos} implantacoes={implantacoes} onSalvarImpl={salvarImpl} currentUser={userProfile}/>}

          {/* CONFIGURAÇÕES */}
          {!clienteSel&&page==='config'&&<ConfigView usuarios={usuarios} currentUser={userProfile} vendedoresCad={vendedoresCad} equipamentosCad={equipamentosCad} menuOrder={menuOrder} onMenuOrderChange={order=>{setMenuOrder(order);}}/>}

          {/* DASHBOARD */}
          {!clienteSel&&page==='dashboard'&&(
            <div>
              <PainelAlertas todos={todos} implantacoes={implantacoes} onVerImplantacao={()=>{setPage('implantacao');setClienteSel(null);}}/>
              {(()=>{const nPagos=todos.filter(c=>c.equipPago==='Não pago');if(!nPagos.length)return null;return(
                <div style={{background:'#fef2f2',border:'1px solid #fecaca',borderRadius:8,padding:'10px 14px',marginBottom:8}}>
                  <div style={{fontWeight:700,fontSize:12,color:C.red,marginBottom:8,display:'flex',alignItems:'center',gap:6}}><i className="ti ti-package" style={{fontSize:15}}/>{nPagos.length} equipamento(s) aguardando pagamento</div>
                  <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                    {nPagos.slice(0,8).map(c=>(
                      <div key={c.id} onClick={()=>setClienteSel(c)} style={{background:'#fff',border:'1px solid #fecaca',borderRadius:5,padding:'4px 10px',cursor:'pointer',fontSize:11}}>
                        <span style={{fontWeight:600,color:C.text}}>{c.nome}</span>
                        <span style={{color:C.textMuted,marginLeft:6}}>{c.equipTipo}</span>
                      </div>
                    ))}
                    {nPagos.length>8&&<span style={{fontSize:11,color:C.textMuted,alignSelf:'center'}}>+{nPagos.length-8} mais</span>}
                  </div>
                </div>
              );})()}
              <DuplasMetas todos={todos} metaSistema={metaSistema} metaEquip={metaEquip} onSetMetaSistema={salvarMetaSistema} onSetMetaEquip={salvarMetaEquip}/>
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))',gap:12,marginBottom:14}}>
                <StatCard icon="ti-users" label="Total clientes" value={cl.length} sub={`${fat.length} fat. / ${agd.length} agd.`} color={C.blue}/>
                <StatCard icon="ti-check" label="Faturados" value={fat.length} sub={moeda(totFat)} color={C.green} onClick={()=>setFiltroStatus('Faturado')}/>
                <StatCard icon="ti-clock" label="Aguardando" value={agd.length} sub={moeda(totAgd)} color={C.orange} onClick={()=>setFiltroStatus('Aguardando')}/>
                <StatCard icon="ti-currency-dollar" label="Receita total" value={moeda(totGeral)} color={C.purple}/>
              </div>
              <GraficoMRR todos={todos}/>
              <div style={{display:'grid',gridTemplateColumns:'2fr 1fr 1fr',gap:12,marginBottom:14}}>
                <div style={{background:C.card,borderRadius:8,padding:'16px',boxShadow:'0 1px 3px rgba(0,0,0,.08)'}}>
                  <div style={{fontWeight:700,fontSize:12,color:C.text,marginBottom:4,textTransform:'uppercase'}}>Faturamento mensal</div>
                  <BarChart data={porMes.map(p=>({l:MESES[p.m].slice(0,1),v:p.fat}))} color={C.blue} height={110}/>
                </div>
                <div style={{background:C.card,borderRadius:8,padding:'16px',boxShadow:'0 1px 3px rgba(0,0,0,.08)'}}>
                  <div style={{fontWeight:700,fontSize:12,color:C.text,marginBottom:10,textTransform:'uppercase'}}>Planos</div>
                  <div style={{display:'flex',alignItems:'center',gap:12}}>
                    <Donut vals={porPlano.map(p=>p.qtd)} colors={[C.blue,C.purple,C.orange]} size={80} label={cl.length} sub="total"/>
                    <div>{porPlano.map(({p,qtd},i)=>{const cors=[C.blue,C.purple,C.orange];return <div key={p} style={{display:'flex',alignItems:'center',gap:6,marginBottom:4}}><div style={{width:8,height:8,borderRadius:2,background:cors[i]}}/><span style={{fontSize:11,color:C.textMuted,flex:1}}>{p}</span><span style={{fontSize:12,fontWeight:700}}>{qtd}</span></div>;})}</div>
                  </div>
                </div>
                <div style={{background:C.card,borderRadius:8,padding:'16px',boxShadow:'0 1px 3px rgba(0,0,0,.08)'}}>
                  <div style={{fontWeight:700,fontSize:12,color:C.text,marginBottom:10,textTransform:'uppercase'}}>Status</div>
                  <div style={{display:'flex',alignItems:'center',gap:12}}>
                    <Donut vals={[fat.length,agd.length]} colors={[C.green,C.orange]} size={80} label={`${Math.round((fat.length/Math.max(cl.length,1))*100)}%`} sub="fat."/>
                    <div>{[{l:'Faturado',v:fat.length,c:C.green},{l:'Aguardando',v:agd.length,c:C.orange}].map(x=><div key={x.l} style={{display:'flex',alignItems:'center',gap:6,marginBottom:4}}><div style={{width:8,height:8,borderRadius:2,background:x.c}}/><span style={{fontSize:11,color:C.textMuted,flex:1}}>{x.l}</span><span style={{fontSize:12,fontWeight:700}}>{x.v}</span></div>)}</div>
                  </div>
                </div>
              </div>
              <div style={{background:C.card,borderRadius:8,boxShadow:'0 1px 3px rgba(0,0,0,.08)',overflow:'hidden'}}>
                <div style={{padding:'12px 16px',borderBottom:`1px solid ${C.border}`,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <span style={{fontWeight:700,fontSize:13,color:C.text}}>Clientes recentes</span>
                  <button onClick={()=>setPage('clientes')} style={{background:'none',border:'none',color:C.blue,cursor:'pointer',fontSize:12,fontWeight:600}}>Ver todos →</button>
                </div>
                <table style={{width:'100%',borderCollapse:'collapse'}}>
                  <thead><tr style={{background:'#f8f9fa'}}>
                    {['Empresa','CNPJ','Plano','Vendedor','Status','Valor'].map(h=><th key={h} style={{padding:'8px 12px',textAlign:'left',fontSize:10,color:C.textMuted,fontWeight:700,textTransform:'uppercase'}}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {[...cl].sort((a,b)=>((b.data?.getTime&&b.data.getTime())||0)-((a.data?.getTime&&a.data.getTime())||0)).slice(0,10).map((c,i)=>(
                      <tr key={c.id} onClick={()=>{setClienteSel(c);}} style={{borderTop:`1px solid ${C.border}`,cursor:'pointer',background:i%2===0?'#fff':'#fdfdfd'}}>
                        <td style={{padding:'8px 12px',fontSize:12,fontWeight:600,color:C.text,maxWidth:160,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{c.nome}</td>
                        <td style={{padding:'8px 12px',fontSize:11,color:C.textMuted}}>{c.cnpj}</td>
                        <td style={{padding:'8px 12px'}}><span style={{background:'#ebf5fb',color:C.blue,padding:'2px 6px',borderRadius:10,fontSize:10,fontWeight:700}}>{c.plano}</span></td>
                        <td style={{padding:'8px 12px',fontSize:11,color:C.textMuted}}>{c.vendedor}</td>
                        <td style={{padding:'8px 12px'}}><span style={{background:c.status==='Faturado'?'#d5f5e3':'#fef9e7',color:c.status==='Faturado'?C.green:C.orange,padding:'2px 7px',borderRadius:10,fontSize:10,fontWeight:700}}>{c.status==='Faturado'?'✓ Fat.':'⏳ Agd.'}</span></td>
                        <td style={{padding:'8px 12px',fontSize:12,fontWeight:700,color:C.blue}}>{moeda(c.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

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
                    <tbody>{agd.map((c,i)=>(
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

          {/* RELATÓRIOS */}
          {!clienteSel&&page==='relatorios'&&<RelatoriosView todos={todos} implantacoes={implantacoes}/>}

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
                    {['Empresa','CNPJ','Contato','Plano','Vendedor','Status','Total'].map(h=><th key={h} style={{padding:'8px 12px',textAlign:'left',fontSize:10,color:C.textMuted,fontWeight:700,textTransform:'uppercase'}}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {cl.slice(0,200).map((c,i)=>(
                      <tr key={c.id} onClick={()=>setClienteSel(c)} style={{borderTop:`1px solid ${C.border}`,cursor:'pointer',background:i%2===0?'#fff':'#fdfdfd'}}>
                        <td style={{padding:'8px 12px',fontSize:12,fontWeight:600,color:C.text,maxWidth:160,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                          {!c._base&&<span style={{background:'#d5f5e3',color:C.green,fontSize:9,padding:'1px 4px',borderRadius:3,marginRight:4}}>novo</span>}{c.nome}
                        </td>
                        <td style={{padding:'8px 12px',fontSize:11,color:C.textMuted}}>{c.cnpj}</td>
                        <td style={{padding:'8px 12px',fontSize:11,color:C.textMuted}}>{c.contato}</td>
                        <td style={{padding:'8px 12px'}}>{c.plano!=='—'&&<span style={{background:'#ebf5fb',color:C.blue,padding:'2px 7px',borderRadius:10,fontSize:10,fontWeight:700}}>{c.plano}</span>}</td>
                        <td style={{padding:'8px 12px',fontSize:11,color:C.textMuted}}>{c.vendedor}</td>
                        <td style={{padding:'8px 12px'}}><span style={{background:c.status==='Faturado'?'#d5f5e3':'#fef9e7',color:c.status==='Faturado'?C.green:C.orange,padding:'2px 8px',borderRadius:10,fontSize:10,fontWeight:700}}>{c.status==='Faturado'?'✓ Fat.':'⏳ Agd.'}</span></td>
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
    </div>
  );
}
