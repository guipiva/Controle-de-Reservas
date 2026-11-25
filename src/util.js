// =============================================================================
// util.js — funções de apoio usadas pelo resto do sistema:
// erro de negócio, datas/fuso horário, regra de sobreposição de horários e senhas.
// =============================================================================
const crypto = require('node:crypto');

/**
 * Erro "esperado" das regras de negócio (ex.: conflito de horário, campo vazio).
 * Diferente de um bug: ele carrega o código HTTP que a API deve devolver
 * (400, 403, 404, 409, 422...) e, opcionalmente, a lista de campos ou motivos.
 * A API (app.js) captura esse erro e transforma em JSON para a tela.
 */
class ErroNegocio extends Error {
  // status HTTP + lista opcional de campos inválidos ou conflitos
  constructor(mensagem, status = 400, detalhes) {
    super(mensagem);
    this.status = status;
    this.detalhes = detalhes;
  }
}

/**
 * Data/hora atual em UTC no formato ISO (ex.: "2026-11-23T21:00:00.000Z").
 * Todo horário oficial vem do servidor, nunca do computador do usuário.
 */
const agoraISO = () => new Date().toISOString();

/**
 * Converte o valor recebido (texto, Date...) para ISO em UTC.
 * Retorna null se a data for inválida, assim a validação consegue avisar o usuário.
 */
function paraISO(valor) {
  if (!valor) return null;
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * REGRA CENTRAL DE CONFLITO (RN-04 e definição da seção 5 da especificação).
 * Os intervalos [iA, fA) e [iB, fB) se sobrepõem quando iA < fB  E  iB < fA.
 * O fim é "aberto": uma reserva das 14h às 16h NÃO conflita com outra das 16h às 18h.
 * "folgaMin" é o intervalo de montagem/desmontagem configurado; ele "estica" os
 * dois intervalos para que reservas coladas passem a conflitar.
 * Exemplo: A = 14h–16h, B = 15h–17h → 14h < 17h e 15h < 16h → conflito.
 */
function sobrepoe(iA, fA, iB, fB, folgaMin = 0) {
  const ms = folgaMin * 60000;
  return new Date(iA).getTime() < new Date(fB).getTime() + ms &&
         new Date(iB).getTime() < new Date(fA).getTime() + ms;
}

/**
 * Gera o hash da senha para guardar no banco (RNF-04).
 * Usa scrypt (algoritmo lento de propósito, dificulta ataques de força bruta)
 * com um "salt" aleatório, para que duas senhas iguais gerem hashes diferentes.
 * Formato salvo: scrypt$<salt>$<hash>. A senha em si nunca é gravada.
 */
function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(senha, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

/**
 * Confere a senha digitada no login com o hash salvo.
 * Recalcula o hash com o mesmo salt e compara com timingSafeEqual,
 * que leva sempre o mesmo tempo (evita descobrir a senha medindo o tempo de resposta).
 */
function conferirSenha(senha, armazenado) {
  const [alg, salt, hash] = String(armazenado).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const calc = crypto.scryptSync(senha, salt, 64);
  const esperado = Buffer.from(hash, 'hex');
  return esperado.length === calc.length && crypto.timingSafeEqual(calc, esperado);
}

/**
 * Retorna a hora local (no fuso da faculdade) em minutos desde 00:00.
 * Ex.: 14:30 → 870. Usado para checar o horário de funcionamento (RN-07),
 * porque no banco as datas estão em UTC (3 horas à frente de Brasília).
 */
function minutosLocais(iso, fuso) {
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone: fuso, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const h = Number(partes.find(p => p.type === 'hour').value);
  const m = Number(partes.find(p => p.type === 'minute').value);
  return h * 60 + m;
}

/**
 * Data local no formato AAAA-MM-DD, no fuso informado.
 */
function dataLocal(iso, fuso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: fuso }).format(new Date(iso)); // AAAA-MM-DD
}

/**
 * Formata data/hora para mensagens ao usuário, no fuso da unidade (RNF-06).
 * Ex.: "26/11/2026, 14:00".
 */
function fmtLocal(iso, fuso = 'America/Sao_Paulo') {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
}
/**
 * Formata um período de forma curta: "26/11/2026, 14:00 às 16:00"
 * (ou com as duas datas, se o período passar de um dia).
 */
function fmtPeriodoLocal(i, f, fuso) {
  const a = fmtLocal(i, fuso), b = fmtLocal(f, fuso);
  return a.slice(0, 10) === b.slice(0, 10) ? `${a} às ${b.slice(-5)}` : `${a} a ${b}`;
}

/**
 * Converte "07:30" em minutos (450), para comparar com minutosLocais().
 */
const hhmmParaMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };

module.exports = {
  ErroNegocio, agoraISO, paraISO, sobrepoe, hashSenha, conferirSenha,
  minutosLocais, dataLocal, hhmmParaMin, fmtLocal, fmtPeriodoLocal,
};
