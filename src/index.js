const Biscoint = require ('biscoint-api-node')
var moment = require('moment');
var numeral = require('numeral');
const logger = require('./logger');
//const TeleBot = require('telebot');
const Telegraf = require('telegraf')
const Extra = require('telegraf/extra')
const Markup = require('telegraf/markup')
const _ = require('lodash');
const cron = require('node-cron');
const axios = require('axios');
const Bottleneck = require('bottleneck');
const env = require("./env")
let operando = false
let play = true

const PKG_TOP_DIR = 'snapshot';
const path = require('path' );

const runInPKG = (function(){
  const pathParsed = path.parse(__dirname);
  const root = pathParsed.root;
  const dir = pathParsed.dir;
  const firstDepth = path.relative(root, dir).split(path.sep)[0];
  return (firstDepth === PKG_TOP_DIR)
})();

let config = null

if(runInPKG) {
  const deployPath = path.dirname(process.execPath);
  config = require(path.join(deployPath, 'config.json'));
} else{
  config = require('../config.json')
}

// read the configurations
let {
  apiKey, apiSecret, montante, valorInicial, moedaCorrente, minPercentualLucro, BOT_TOKEN, BOT_CHAT, dataInicial, botId, intervalo, host1, host2, port, multibot
} = config;
let bc, isQuote;
let robo = new Object()
robo.id = botId
let botStatus = false
let operacao = new Object()
operacao.status = false
if (multibot==undefined || multibot==null){
  multibot=false
}

const limiter = new Bottleneck({
  reservoir: 30,
  reservoirRefreshAmount: 30,
  reservoirRefreshInterval: 60 * 1000,
  maxConcurrent: 1,
});

//---------------------INSTANCIAR BOT TELEGRAM-----------------------

const bot = new Telegraf(BOT_TOKEN)

//---------------------FUNÇÕES-----------------------
const init = () => {
  if (!apiKey) {
    imprimirMensagem('Necessário verificar a "apiKey" em config.json', 'error', true);
  }
  if (!apiSecret) {
    imprimirMensagem('Necessário verificar a "apiSecret" em config.json', 'error', true);
  }
  moedaCorrente = _.toUpper(moedaCorrente);
  if (!['BRL'].includes(moedaCorrente)) {
    imprimirMensagem('"moedaCorrente" deve ser "BRL". Verifique seu arquivo config.json', 'error', true);
  }

  if (isNaN(montante)) {
    imprimirMensagem(`Inválido montante "${montante}. Por favor, especifique um montante para operação válido em config.json`, 'error', true);
  }

  //isQuote = moedaCorrente === 'BRL';
  isQuote = true

  bc = new Biscoint({
    apiKey: apiKey,
    apiSecret: apiSecret
  });

};

const checkExtrato = async () => {
  let { BRL, BTC } = await bc.balance();
  let lucro = await bc.ticker();
  let valorTotal = BRL
  imprimirMensagem(`Balances:  BRL: ${BRL} - BTC: ${BTC} `);
  let moment1 = moment();
  let moment2 = moment(dataInicial, "DD/MM/YYYY");
  let dias = moment1.diff(moment2, 'days');
  let lucroRealizado = percent(valorInicial, valorTotal);
  bot.telegram.sendMessage(BOT_CHAT, 
    `\u{1F911} Balanço:
  <b>Status</b>: ${play ? `\u{1F51B} Robô operando.`:`\u{1F6D1} Robô parado.` } 
  Data Inicial: ${moment2.format("DD/MM/YYYY")} 
  Dias Operando: ${dias}
  Depósito Inicial: R$ ${valorInicial}  
  <b>BRL:</b> ${BRL} 
  <b>BTC:</b> ${BTC} (R$ ${(lucro.last*BTC).toFixed(2)})
  Operando com: R$ ${montante}
  ============                                                
  Lucro Parcial: ${lucroreal(valorTotal, lucro.last*BTC).toFixed(2)}% (R$ ${(lucro.last*BTC).toFixed(2)})
  Lucro Realizado: ${lucroRealizado.toFixed(2)}% (R$ ${(valorTotal - valorInicial).toFixed(2)});
  <b>Lucro Total: ${(lucroreal(valorTotal, lucro.last*BTC) + lucroRealizado).toFixed(2)}% (R$ ${(lucro.last*BTC + (valorTotal - valorInicial)).toFixed(2)})</b>
  ============
  `, replyMarkup.HTML())
  let nAmount = Number(montante);
  let amountBalance = isQuote ? BRL : BTC;
  if (nAmount > Number(amountBalance)) {
    logger.warn(`O valor ${montante}, informado no aquivo de configuração, é maior que o saldo de ${isQuote ? 'BRL' : 'BTC'} do usuário. Saldo do usuário: ${isQuote ? 'BRL' : 'BTC'} ${amountBalance}`)
    montante=amountBalance    
  }
};

const inicializarSaldo = async() => {
  logger.info(`Inicializando saldo....`)
  try {
    let { BRL, BTC } = await bc.balance();
    montante = BRL    
  } catch (error) {
    //imprimirMensagem(JSON.stringify(error));
    logger.error(`Erro: ${error}`)
  }
}

const checkInterval = async () => {
  const { endpoints } = await bc.meta();
  const { windowMs, maxRequests } = endpoints.offer.post.rateLimit;
  imprimirMensagem(`Limite de requisições: ${maxRequests} requisições por ${windowMs}ms.`);
  let minInterval = 2 * windowMs / maxRequests / 1000;

  if (!intervalo) {
    intervalo = minInterval;
    imprimirMensagem(`Setando intervalo de requisições para ${intervalo}s`);
  } else if (intervalo < minInterval) {
    //imprimirMensagem(`Interval too small (${intervalo}s). Must be higher than ${minInterval.toFixed(1)}s`, 'error', true);
    logger.error(`Intervalo de requisições configurado é muito pequeno: (${intervalo}s). Sugerimos que seja maior ou igual a ${minInterval.toFixed(1)}s.`)
    imprimirMensagem(`Setando intervalo de requisições para ${intervalo}s`);
  }
};

async function realizarLucro(valor){
  return new Promise((resolve, reject) => {
    (async() => {
      try {        
        if (valor>=0.001){
          let sellLucro = await bc.offer({
            amount: valor,
            isQuote: false,
            op: 'sell',
          });
    
          try {
            await bc.confirmOffer({
               offerId: sellLucro.offerId,
            });
            let { BRL, BTC } = await bc.balance();
            montante = BRL            
            resolve(true)     
          } catch (error) {
            bot.telegram.sendMessage(BOT_CHAT, `${error.error}. ${error.details} `);
            logger.error(`${error.error}. ${error.details}`)
            reject(false)
          }
        }
        else {
          bot.telegram.sendMessage(BOT_CHAT, "Valor de venda abaixo do limite mínimo de 0.001");
          logger.warn(`Valor de venda abaixo do limite mínimo de 0.001`)
          reject(false)
        }      
      } catch (error) {
        bot.telegram.sendMessage(BOT_CHAT, `${error.error}. ${error.details} `);
        logger.error(`${error.error}. ${error.details}`)
        reject(false)
      }
    })();
})
  
}

async function trader() {
  if(play){
    if(!operando){       
        if(multibot) {   
          const res = await axios.post(`http://${host}:${port}/status`, robo)
          botStatus = res.data          
        }else{
          botStatus = true
        }
        let buyOffer
        let sellOffer
        let profit
        if (botStatus){
          try {
            buyOffer = await bc.offer({
              amount: montante,
              isQuote,
              op: 'buy',
            });
        
            sellOffer = await bc.offer({
              amount: montante,
              isQuote,
              op: 'sell',
            });
        
            profit = percent(buyOffer.efPrice, sellOffer.efPrice);
			profitBRL = (montante*profit)/100
            imprimirMensagem(`Variação de preço calculada: ${profit.toFixed(3)}%`);
            if (profit >= minPercentualLucro) {
              //Inicia a operação e trava o bot para novas operações até o final da operação corrente, seja quando é realizado um luco
              //ou quando ocorre um erro.
              operando = true        
  
              //Confirma as ordens
              try {
  
                await bc.confirmOffer({
                  offerId: buyOffer.offerId,
                });
        
                await bc.confirmOffer({
                  offerId: sellOffer.offerId,
                });
                      
                //imprimirMensagem(`Sucesso, lucro: + ${profit.toFixed(3)}%`);
                bot.telegram.sendMessage(BOT_CHAT, `\u{1F911} Sucesso! Lucro: + ${profit.toFixed(3)}% \n R$ ${profitBRL.toFixed(2)}`, replyMarkup);
                logger.info(`Sucesso! Lucro: + ${profit.toFixed(3)}% \n R$ ${profitBRL.toFixed(2)}`)
                let { BRL, BTC } = await bc.balance();
                if(BTC >= 0.001){
                  try {
                    bot.telegram.sendMessage(BOT_CHAT, "Tentando realizar o lucro...");
                    let lucroRealizado = await realizarLucro(BTC)
                    if(lucroRealizado) {
                      bot.telegram.sendMessage(BOT_CHAT, "ok! Lucro realizado", replyMarkup);
                      logger.info(`Lucro realizado. Valor: ${BTC}`)                                                       
                    }
                  } catch (error) {
                    //imprimirMensagem(`Erro ao tentar realizar lucro: ${JSON.stringify(error)}`);
                    logger.error(`${JSON.stringify(error)}`)
                  }          
                }
                //libera o robô para realizar novas operações
                operando=false
  
              } catch (error) {
                //imprimirMensagem(`Error on confirm offer: ${JSON.stringify(error)}`);
                logger.error(`Erro ao confirmar a oferta: ${JSON.stringify(error)}`)     
                try {
                  let { BRL, BTC } = await bc.balance();              
                  if(BTC >= 0.001){
                    bot.telegram.sendMessage(BOT_CHAT, "Não foi possível confirmar a venda de BTC. O BTC será vendido a mercado!");
                    let lucroRealizado = await realizarLucro(BTC)
                    if(lucroRealizado) {
                      bot.telegram.sendMessage(BOT_CHAT, "Ok! Saldo em BTC foi vendido a mercado.", replyMarkup);  
                      logger.info(`Venda de BTC a mercado. Valor: ${BTC}`)
                    }
                  } 
                } catch (error) {
                      //imprimirMensagem(`Erro ao tentar realizar lucro: ${JSON.stringify(error)}`);
                      logger.error(`${JSON.stringify(error)}`)
                  }          
                operando=false
              }
            }
          } catch (error) {
            //imprimirMensagem(`Error on get offer': ${JSON.stringify(error)}`);
            logger.error(`Erro ao obter oferta: ${JSON.stringify(error)}`)
            try {
              let { BRL, BTC } = await bc.balance();              
              if(BTC >= 0.001){
                bot.telegram.sendMessage(BOT_CHAT, "Não foi possível confirmar a venda de BTC. O BTC será vendido a mercado!");
                let lucroRealizado = await realizarLucro(BTC)
                if(lucroRealizado) {
                  bot.telegram.sendMessage(BOT_CHAT, "Ok! Saldo em BTC foi vendido a mercado."); 
                  logger.info(`Venda de BTC a mercado. Valor: ${BTC}`)
                }
              } 
            } catch (error) {
                  //imprimirMensagem(`Erro ao tentar realizar lucro: ${JSON.stringify(error)}`);
                  logger.error(`${JSON.stringify(error)}`)
              }          
            operando=false
          }
    
        } else{
          imprimirMensagem('Aguardando...');
        }    
    } else{
      imprimirMensagem('Operando! Aguardando conclusão...');
    }
  } else{
    imprimirMensagem('Robô pausado pelo usuário... Para iniciar aperte o botão Iniciar Robô no Telegram.');
  }
  
}

const startTrading = async () => {
  //imprimirMensagem('Starting trades');
  logger.info(`Iniciando trades.`)
  bot.telegram.sendMessage(BOT_CHAT, '\u{1F911} Iniciando trades!');
  await trader();
  // setInterval(trader, intervalo * 1000);
  setInterval(async () => {
	limiter.schedule(() => trader());
}, intervalo * 1000);
};

function gravarJSON(nomeArquivo, dados) {

  return new Promise((resolve, reject) => {
      const fs = require('fs');
      let sureJSON = JSON.stringify(dados)    
      // Gravando arquivo em'sure.json' . 
      fs.writeFile(nomeArquivo, sureJSON, (err) => {  
          if (err) reject(err)
          else resolve("Sucesso!")
      })

  })
}

//---------------------FIM FUNÇÕES-----------------------

//---------------------TECLADO TELEGRAM-----------------------

/* const replyMarkup = bot.inlineKeyboard([
  [bot.inlineButton('\u{1F51B} Iniciar Robô', {callback: '/iniciar'}),bot.inlineButton('\u{1F6D1} Parar Robô', {callback: '/parar'})],
  [bot.inlineButton('\u{1F4B0} Valor Inicial', {callback: '/valor'}),bot.inlineButton('\u{1F4D6} Ajuda', {callback: '/ajuda'})],
  [bot.inlineButton('\u{1F9FE} Extrato', {callback: '/extrato'})]
], {resize: true}); */

const replyMarkup = Extra.markup(Markup.inlineKeyboard([ 
    Markup.callbackButton('\u{1F51B} Iniciar Robô', 'iniciar'),
    Markup.callbackButton('\u{1F6D1} Parar Robô', 'parar'),
    Markup.callbackButton('\u{1F4D6} Ajuda', 'ajuda'),
    Markup.callbackButton('\u{1F9FE} Extrato', 'extrato')
], { columns: 2 }))


//---------------------COMANDOS TELEGRAM-----------------------


//Inicia as operações de trader
bot.action('iniciar', ctx => {
  logger.info('Bot iniciado pelo usuário.')
  play = true
  ctx.reply('\u{1F911} Iniciando Trades...');
  checkExtrato();
});

//Para as operações de trader
bot.action('parar', ctx => {
  logger.info('Bot parado pelo usuario. Para iniciar selecione o Botão Iniciar no Telegram.')
  play = false
  ctx.reply(`\u{1F6D1} Ok! Robô parado para operações...`, replyMarkup);
});

//exibe um resumo com os comandos disponíveis
bot.action('ajuda', ctx => {
  logger.info('Comando Ajuda executado.')
  //bot.editMessageReplyMarkup(replyMarkup, [{chat_id: BOT_CHAT}])
  ctx.reply(
  `<b>Comandos disponíveis:</b> 
  ============  
  <b>\u{1F51B} Iniciar Robô:</b> Incia as operações. Default no primeiro acesso.\n
  <b>\u{1F6D1} Parar Robô:</b> Para as operações. Demais comandos ficam disponíveis.\n
  <b>\u{1F9FE} Extrato:</b> Extrato com o saldo, valor de operação, lucro, etc.
  ============
  `, replyMarkup)
});

//exibe uma lista das 10 últimas transações
bot.command('report', ctx => {
  logger.info('Comando Relatório executado.') 		
	let resposta
	const report = bc.trades().then(res => {
			resposta = res;
			 for(let i=0; i<resposta.length; i++){
				console.log(resposta)
				ctx.reply( 
				'OP: ' + resposta[i].op + '\n' +
				'BTC: ' + resposta[i].baseAmount + '\n' + 
				'BRL: ' + resposta[i].quoteAmount + '\n'  +
				'BRL/BTC: ' + resposta[i].efPrice + '\n' + 
				'Data: ' + moment(resposta[i].date).format("DD/MM/YYYY HH:mm")
				);
			}	
						
    }).catch(e => {
      logger.error(`Comando Relatório: ${e}`)});
});

//exibe o relatório com o extrato contendo saldo, lucro, tempo de operação, etc.
bot.action('extrato', ctx => {
  logger.info('Comando Extrato executado')
  checkExtrato();
});

//atualiza o saldo de operação
bot.command('restart', ctx => {
  logger.info('Comando Restart executado.')
  ctx.reply('Atualizando saldo inicial...');
  try {
    inicializarSaldo();
    ctx.reply('Ok! Saldo inicial atualizado.');
  } catch (error) {
    logger.error(`Comando Restart:
    ${error}`)
    ctx.reply('error');
  }  
});

//altera a data inicial
bot.command(/^\/inicio (.+)$/, ctx => {
  logger.info('Comando Inicio executado.')
  dataInicial = ctx.match[0];  
  ctx.reply(`Ok! Data Incial alterado para: ${dataInicial}`);
});

//venda manual de valores
/* bot.on(/^\/venda (.+)$/, (msg, props) => {
  //imprimirMensagem('Tentando realizar a venda manual');
  let valor = props.match[1];
  logger.info(`Comando Venda executado. Valor inserido ${valor}`)
  if(valor.match(/,/)){
    bot.sendMessage(BOT_CHAT, 
      `Erro! Tente um valor com o seguinte formato:
       Insira apenas números;
       Valores positivos;
       Utilize ponto para separar as casas decimais.
       Ex.: 
       1000.00 \u{2714} 
       1000,00 \u{274C}
       R$ 1000,00 \u{274C}
       Mil reais \u{274C}     
       `);
       logger.warn(`Comando Venda. Valor mal formatado, inserido o caracterer ','`)
  } else{
    if (numeral.validate(valor,'en')){
       valor = numeral(valor).format('0[.]00000000')
       if(Number(valor)>0){
         realizarLucro(Number(valor))
           .then(res =>{
             //imprimirMensagem('Venda realizada com sucesso!');
             bot.sendMessage(BOT_CHAT, `Ok! venda realizada com sucesso!` );
             logger.info(`Comando Venda. Venda manual realizada. Valor: ${valor}`)
           })
           .catch(e =>{
             //imprimirMensagem(`Não foi possível realizar a venda`);
             logger.error(`Comando Venda. Não foi possível realizar a venda. Erro: ${e}`)
           })     
       }else{
          bot.sendMessage(BOT_CHAT, `Insira um valor válido` );
          logger.warn(`Comando Venda. Valor inserido menor que Zero. Valor digitado pelo usuário: ${valor}`)
       }
    }else {
      bot.sendMessage(BOT_CHAT, 
      `Erro! Tente um valor com o seguinte formato:
       Insira apenas números;
       Valores positivos;
       Utilize ponto para separar as casas decimais.
       Ex.: 
       1000.00 \u{2714} 
       1000,00 \u{274C}
       R$ 1000,00 \u{274C}
       Mil reais \u{274C}     
       `
        );
        logger.warn(`Comando Venda. Valor mal formatado, inserido o caracterer inválido. Valor digitado pelo usuário: ${valor}`)
    }
  }
}); */

//Altera o valor do quantitativo em operação (amount)
/* bot.on(/^\/usar (.+)$/, (msg, props) => {  
  let valor = props.match[1]  
  logger.info(`Comando Valor para Operação executado. Valor: ${valor}`)
  if(valor.match(/,/)){
    bot.sendMessage(BOT_CHAT, 
      `Erro! Tente um valor com o seguinte formato:
       Insira apenas números;
       Valores positivos;
       Utilize ponto para separar as casas decimais.
       Ex.: 
       1000.00 \u{2714} 
       1000,00 \u{274C}
       R$ 1000,00 \u{274C}
       Mil reais \u{274C}     
       `);
       logger.warn(`Comando Valor para Operação. Valor mal formatado, inserido o caracterer ','`)
  } else {
    if (numeral.validate(valor,'en')){
      valor = numeral(valor).format('0[.]00')
      imprimirMensagem('Atualizando o montante para operação...');
      (async() => {
        try {
          if(Number(valor)>0){
            let { BRL, BTC } = await bc.balance();
            if(Number(valor) <= BRL) {
                montante = Number(valor);  
                bot.sendMessage(BOT_CHAT, `Ok! Operando com: ${valor}` );
                logger.info(`Comando Valor para Operação. Valor para operação alterado para ${valor}`)
              } else {
                bot.sendMessage(BOT_CHAT, `Saldo insuficiente!` );
                logger.warn(`Comando Valor para Operação. Saldo insuficiente. Valor digitado pelo usuário: ${valor}`)
              }     
          }else{
              bot.sendMessage(BOT_CHAT, `Insira um valor válido` );
              logger.warn(`Comando Valor para Operação. Valor inserido menor que Zero. Valor digitado pelo usuário: ${valor}`)
          }
        } catch (error) {
          bot.sendMessage(BOT_CHAT, `Ocorreu um erro inesperado, tente novamente mais tarde.` );
          logger.error(`Comando Valor para Operação. Ocorreu um erro inesperado: ${error}`)
          //imprimirMensagem(JSON.stringify(error));
        }  
      })()
    }else {
      bot.sendMessage(BOT_CHAT, 
      `Erro! Tente um valor com o seguinte formato:
       Insira apenas números;
       Valores positivos;
       Utilize ponto para separar as casas decimais.
       Ex.: 
       1000.00 \u{2714} 
       1000,00 \u{274C}
       R$ 1000,00 \u{274C}
       Mil reais \u{274C}     
       `
        );
        logger.warn(`Comando Valor para Operação. Valor mal formatado, inserido o caracterer inválido. Valor digitado pelo usuário: ${valor}`)
    }
  }
});
 */
//Altera o valor inicial registrado para fins de cálculo do lucro
/* bot.on('/valor', msg => {  
  // Ask user name
  return bot.sendMessage(BOT_CHAT, 'Digite um valor inicial para cálculo do lucro. Ex.: 1000.00 ', {ask: 'valorInicial'});

});
 */
/* bot.on('ask.valorInicial', msg => {
  console.log(msg.text)
  let valor = msg.text  
  logger.info(`Comando Valor Inicial executado. Valor: ${valor}`)
  if(valor.match(/,/)){
    bot.sendMessage(BOT_CHAT, 
      `Erro! Tente um valor com o seguinte formato:
       Insira apenas números;
       Valores positivos;
       Utilize ponto para separar as casas decimais.
       Ex.: 
       1000.00 \u{2714} 
       1000,00 \u{274C}
       R$ 1000,00 \u{274C}
       Mil reais \u{274C}     
       `, replyMarkup);
       logger.warn(`Comando Valor Inicial. Valor mal formatado, inserido o caracterer ','`)
  } else {
    if (numeral.validate(valor,'en')){
      valor = numeral(valor).format('0[.]00')
      imprimirMensagem('Atualizando o valor inicial para operação...');
      try {
        if(Number(valor)>0){
            valorInicial = Number(valor);  
            bot.sendMessage(BOT_CHAT, `Ok! valor inicial alterado para: ${valor}`, replyMarkup );
            logger.info(`Comando Valor Inicial. Valor Inicial alterado para ${valor}`)   
        }else{
            bot.sendMessage(BOT_CHAT, `Insira um valor válido.`, replyMarkup );
            logger.warn(`Comando Valor Inicial. Valor inserido menor que Zero. Valor digitado pelo usuário: ${valor}`, replyMarkup)
        }
      }catch (error) {
        bot.sendMessage(BOT_CHAT, `Ocorreu um erro inesperado, tente novamente mais tarde.`, replyMarkup );
        logger.error(`Comando Valor Inicial. Ocorreu um erro inesperado: ${error}`)
        //imprimirMensagem(JSON.stringify(error));
      }  
    }else {
      bot.sendMessage(BOT_CHAT, 
      `Erro! Tente um valor com o seguinte formato:
       Insira apenas números;
       Valores positivos;
       Utilize ponto para separar as casas decimais.
       Ex.: 
       1000.00 \u{2714} 
       1000,00 \u{274C}
       R$ 1000,00 \u{274C}
       Mil reais \u{274C}     
       `, replyMarkup);
      logger.warn(`Comando Valor Inicial. Valor mal formatado, inserido o caracterer inválido. Valor digitado pelo usuário: ${valor}`)  
    }
  }
});

 */
//---------------------FIM BOT TELEGRAM-----------------------


// -- UTILITY FUNCTIONS --

function percent(value1, value2) {
  return (Number(value2) / Number(value1) - 1) * 100;
}

function lucroreal(value1, value2) {
  return (Number(value2) / Number(value1)) * 100;
}

function imprimirMensagem(message, throwError = false) {
  console.log(`[${play ? `ROBÔ EM OPERAÇÃO`:`ROBÔ PARADO` }] - ${message}`);
  if (throwError) {
    throw new Error(message);
  }
}



//---------------------AGENDAMENTO API TELEGRAM-----------------------

//Atualiza a hora e reinicia o saldo a cada 30 minutos
cron.schedule("*/30 */12 * * *", () => {    
  try {
    //shell.exec('service ntp stop');
    //shell.exec('service ntp start');
   // inicializarSaldo()  
	bot.telegram.sendMessage(BOT_CHAT, `Monitorando o mercado!`);
  } catch (error) {
    imprimirMensagem(JSON.stringify(error));
  }
});

//--------------------- FIM AGENDAMENTO API TELEGRAM-----------------------

//---------------------START BOT-----------------------
async function start() {      
      init();
      await inicializarSaldo();     
      await checkExtrato();
      await checkInterval();
      await startTrading();  
}
bot.launch()
start().catch(e => imprimirMensagem(JSON.stringify(e), 'error'));
//Fim
