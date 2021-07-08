const Biscoint = require('biscoint-api-node')
var moment = require('moment');
var numeral = require('numeral');
const logger = require('./logger');
const Telegraf = require('telegraf')
const Extra = require('telegraf/extra')
const Markup = require('telegraf/markup')
const _ = require('lodash');
const cron = require('node-cron');
const axios = require('axios');
const Bottleneck = require('bottleneck');
const json = require('json-update')
const fs = require("fs");

let operando = false
let play = true
let acbrl
let acbtc
let host

const PKG_TOP_DIR = 'snapshot';
const path = require('path');

const runInPKG = (function () {
  const pathParsed = path.parse(__dirname);
  const root = pathParsed.root;
  const dir = pathParsed.dir;
  const firstDepth = path.relative(root, dir).split(path.sep)[0];
  return (firstDepth === PKG_TOP_DIR)
})();

let config = null

if (runInPKG) {
  const deployPath = path.dirname(process.execPath);
  config = require(path.join(deployPath, 'config.json'));
} else {
  config = require('../config.json')
}

// Função para registrar o saldo acumulado do bot
async function lucroAcumulado(profit) {
  let data = await json.load('./lucro.json');
  let lucro = data.lucro + profit;
  await json.update('./lucro.json', { lucro: lucro });
  //console.log(lucro.toFixed(2))
}

// configurações das variáveis
let {
  apiKey, apiSecret, apiKeyBinance, apiSecretBinance, depositoUSDT, dataInicialBinance, montante, valorInicial, moedaCorrente, moedaAcumular, minPercentualLucro, BOT_TOKEN, BOT_CHAT, dataInicial, botId, intervalo, host1, host2, port, multibot
} = require("./env")
let bc, isQuote;
let robo = new Object()
robo.id = botId
let botStatus = false
let operacao = new Object()
operacao.status = false

if (multibot == undefined || multibot == null) {
  multibot = false
}

if (moedaAcumular == "BRL") {
  acbrl = true
} else {
  acbtc = true
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
  //let jsonData = await JSON.parse(fs.readFileSync("./lucro.json", "utf8"))
  //let lucroAcumuladoTotal = await jsonData.lucro
  let valorTotal = BRL
  imprimirMensagem(`Balances:  BRL: ${BRL} - BTC: ${BTC} `);
  let moment1 = moment();
  let moment2 = moment(dataInicial, "DD/MM/YYYY");
  let dias = moment1.diff(moment2, 'days');
  let lucroRealizado = percent(valorInicial, valorTotal);
  await bot.telegram.sendMessage(BOT_CHAT,
    `\u{1F911} Balanço:
  <b>Status</b>: ${play ? `\u{1F51B} Robô operando.` : `\u{1F6D1} Robô parado.`} 
  <b>Acumulando</b>: ${acbrl ? `\u{1F4B5} Real.` : `\u{1F680} BTC.`} 
  Data Inicial: ${moment2.format("DD/MM/YYYY")} 
  Dias Operando: ${dias}
  Depósito Inicial: R$ ${valorInicial}  
  <b>BRL:</b> ${BRL} 
  <b>BTC:</b> ${BTC} (R$ ${(lucro.last * BTC).toFixed(2)})
  Operando com: R$ ${montante}
  ============                                                
  Lucro Parcial: ${lucroreal(valorTotal, lucro.last * BTC).toFixed(2)}% (R$ ${(lucro.last * BTC).toFixed(2)})
  Lucro Realizado: ${lucroRealizado.toFixed(2)}% (R$ ${(valorTotal - valorInicial).toFixed(2)});
  <b>Lucro Total: ${(lucroreal(valorTotal, lucro.last * BTC) + lucroRealizado).toFixed(2)}% (R$ ${(lucro.last * BTC + (valorTotal - valorInicial)).toFixed(2)})</b>
  ============
  `, replyMarkup.HTML())
  let nAmount = Number(montante);
  let amountBalance = isQuote ? BRL : BTC;
  if (nAmount > Number(amountBalance)) {
    logger.warn(`O valor ${montante}, informado no aquivo de configuração, é maior que o saldo de ${isQuote ? 'BRL' : 'BTC'} do usuário. Saldo do usuário: ${isQuote ? 'BRL' : 'BTC'} ${amountBalance}`)
    montante = amountBalance
  }
};

const inicializarSaldo = async () => {
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

async function realizarLucro(valor) {
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        if (valor >= 0.001) {
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
		let { BRL, BTC } = await bc.balance();  
        bot.telegram.sendMessage(BOT_CHAT, `Verifique o seu saldo em BTC e tente novamente. \nO seu saldo atual em Bitcoin é de ${BTC}`);
        logger.error(`${error.error}. ${error.details}`)
        reject(false)
      }
    })();
  }).catch(err => {
    console.error(err)
    logger.error(`${err}`)
  })
}

async function comprarBTC(valor) {
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        if (valor >= 50) {
          let buyOffer = await bc.offer({
            amount: valor,
            isQuote: true,
            op: "buy"
          });
          try {
            await bc.confirmOffer({
              offerId: buyOffer.offerId,
            });
            bot.telegram.sendMessage(BOT_CHAT, `Compra de ${valor} em BTC efetuada com sucesso!`);
            resolve(true)     
          } catch (error) {
            bot.telegram.sendMessage(BOT_CHAT, `${error.error}. ${error.details}`);
            logger.error(`${error.error}. ${error.details}`)
            reject(false)
          }
        }
        else {
          bot.telegram.sendMessage(BOT_CHAT, "Valor de compra abaixo do limite mínimo de 50 reais");
          logger.warn(`Valor de venda abaixo do limite mínimo de 0.001`)
          reject(false)
        }
      } catch (error) {
        bot.telegram.sendMessage(BOT_CHAT, `${error.error}. ${error.details}`);
        logger.error(`${error.error}. ${error.details}`)
        reject(false)
      }
    })();
  }).catch(err => {
    console.error(err)
    logger.error(`${err}`)
  })
}

bot.action('comprar', async ctx => {
  //const nome = ctx.from.first_name
  let { BRL, BTC } = await bc.balance();
  ctx.replyWithMarkdown(`Para comprar Bitcoin digite o seguinte comando (/comprar qtdeReal)\nExemplo: /comprar ${BRL}`)
}
)

bot.hears(/^\/comprar (.+)$/, async ctx => {
  let valor = ctx.match[1];
  comprarBTC(valor)
}
)

bot.action('vender', async ctx => {
  //const nome = ctx.from.first_name
  let { BRL, BTC } = await bc.balance();
  ctx.replyWithMarkdown(`Para vender Bitcoin digite o seguinte comando (/vender qtdeBitcoin)\nExemplo: /vender ${BTC}`)
}
)

bot.hears(/^\/vender (.+)$/, async ctx => {
  let valor = ctx.match[1];
  await realizarLucro(valor)
}
)

function checkServer(url) {
  const controller = new AbortController();
  const signal = controller.signal;
  const options = { mode: 'no-cors', signal };
  return fetch(url, options)
    .then(setTimeout(() => { controller.abort() }, timeout))
    .then(response => console.log('Check server response:', response.statusText))
    .catch(error => console.error('Check server error:', error.message));
}

async function trader() {
  if (play) {
    if (!operando) {
      if (multibot) {
		//console.log(host)
		let numHost = [host1, host2]
		let hosts = []
		for (var i = 0; i < 2; i++) {
		await axios.post(`http://${numHost[i]}:${port}/status`, robo)
		.then((response) => {
			if (response.status == 200) {
				hosts.push(numHost[i])
				if (hosts.length == 2) {
					host = hosts[0]
				} else {
					host = numHost[i]
				}
			}
		})
		.catch((error) => { 
			//console.log(error)
		}
		)
		}	
		console.log(host)
		await axios.post(`http://${host}:${port}/status`, robo)
		.then((response) => {
        // Success 🎉
        botStatus = response.data
		//console.log(botStatus);
		})
		.catch((error) => {
        // Error 😨
        if (error.response) {
            /*
             * The request was made and the server responded with a
             * status code that falls out of the range of 2xx
             */
            console.log(error.response.data);
            console.log(error.response.status);
            console.log(error.response.headers);
        } else if (error.request) {
            /*
             * The request was made but no response was received, `error.request`
             * is an instance of XMLHttpRequest in the browser and an instance
             * of http.ClientRequest in Node.js
             */
			console.log(error.request);
        } else {
            // Something happened in setting up the request and triggered an Error
			console.log('Error', error.message);
        }
       // console.log(error.config);
		bot.telegram.sendMessage(BOT_CHAT, `Os servidores estão offline. Verifique!`)
    });
      } else {
        botStatus = true
      }
	  console.log(botStatus)
      let buyOffer
      let sellOffer
      let profit
      if (botStatus) {
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
          profitBRL = (montante * profit) / 100
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
              lucroAcumulado(profit).then(() => { }).catch(e => { logger.error(e) });
              // Se acbtc for true, faz a venda proporcional
              if (acbtc && BTC >= 0.001) {
                try {
                  bot.telegram.sendMessage(BOT_CHAT, "Tentando realizar o lucro...");
                  let priceBTC = await bc.ticker();
                  let valorAtual = (valorInicial / priceBTC.last).toFixed(8);
                  let lucroRealizado = await realizarLucro(valorAtual)
                  if (lucroRealizado) {
                    bot.telegram.sendMessage(BOT_CHAT, "ok! Lucro realizado", replyMarkup);
                    inicializarSaldo();
                    logger.info(`Lucro realizado. Valor: ${BTC}`)
                  }
                } catch (error) {
                  //imprimirMensagem(`Erro ao tentar realizar lucro: ${JSON.stringify(error)}`);
                  logger.error(`${JSON.stringify(error)}`)
                }
              } else if (BTC >= 0.001) {
                try {
                  bot.telegram.sendMessage(BOT_CHAT, "Tentando realizar o lucro...");
                  let priceBTC = await bc.ticker();
                  let { BRL, BTC } = await bc.balance();
                  let lucroRealizado = await realizarLucro(BTC)
                  if (lucroRealizado) {
                    bot.telegram.sendMessage(BOT_CHAT, "ok! Lucro realizado", replyMarkup);
                    inicializarSaldo();
                    logger.info(`Lucro realizado. Valor: ${BTC}`)
                  }
                } catch (error) {
                  //imprimirMensagem(`Erro ao tentar realizar lucro: ${JSON.stringify(error)}`);
                  logger.error(`${JSON.stringify(error)}`)
                }
              }
              //libera o robô para realizar novas operações
              operando = false

            } catch (error) {
              //imprimirMensagem(`Error on confirm offer: ${JSON.stringify(error)}`);
              logger.error(`Erro ao confirmar a oferta: ${JSON.stringify(error)}`)
              bot.telegram.sendMessage(BOT_CHAT, `${error.error}. ${error.details}`);
              // Se acbtc for true, faz a venda proporcional
              if (acbtc && BTC >= 0.001) {
                try {
                  bot.telegram.sendMessage(BOT_CHAT, "Tentando realizar o lucro...");
                  let priceBTC = await bc.ticker();
                  let valorAtual = (valorInicial / priceBTC.last).toFixed(8);
                  let lucroRealizado = await realizarLucro(valorAtual)
                  if (lucroRealizado) {
                    bot.telegram.sendMessage(BOT_CHAT, "ok! Lucro realizado", replyMarkup);
                    inicializarSaldo();
                    logger.info(`Lucro realizado. Valor: ${BTC}`)
                  }
                } catch (error) {
                  //imprimirMensagem(`Erro ao tentar realizar lucro: ${JSON.stringify(error)}`);
                  logger.error(`${JSON.stringify(error)}`)
                }
              } else if (BTC >= 0.001) {
                try {
                  bot.telegram.sendMessage(BOT_CHAT, "Tentando realizar o lucro...");
                  let priceBTC = await bc.ticker();
                  let { BRL, BTC } = await bc.balance();
                  let lucroRealizado = await realizarLucro(BTC)
                  if (lucroRealizado) {
                    bot.telegram.sendMessage(BOT_CHAT, "ok! Lucro realizado", replyMarkup);
                    inicializarSaldo();
                    logger.info(`Lucro realizado. Valor: ${BTC}`)
                  }
                } catch (error) {
                  //imprimirMensagem(`Erro ao tentar realizar lucro: ${JSON.stringify(error)}`);
                  logger.error(`${JSON.stringify(error)}`)
                }
              }
              operando = false
            }
          }
        } catch (error) {
          //imprimirMensagem(`Error on get offer': ${JSON.stringify(error)}`);
          logger.error(`Erro ao obter oferta: ${JSON.stringify(error)}`)
          let { BRL, BTC } = await bc.balance();
          // Se acbtc for true, faz a venda proporcional
          if (acbtc && BTC >= 0.001) {
            try {
              bot.telegram.sendMessage(BOT_CHAT, "Tentando realizar o lucro...");
              let priceBTC = await bc.ticker();
              let valorAtual = (valorInicial / priceBTC.last).toFixed(8);
              let lucroRealizado = await realizarLucro(valorAtual)
              if (lucroRealizado) {
                bot.telegram.sendMessage(BOT_CHAT, "ok! Lucro realizado", replyMarkup);
                inicializarSaldo();
                logger.info(`Lucro realizado. Valor: ${BTC}`)
              }
            } catch (error) {
              //imprimirMensagem(`Erro ao tentar realizar lucro: ${JSON.stringify(error)}`);
              logger.error(`${JSON.stringify(error)}`)
            }
          } else if (BTC >= 0.001) {
            try {
              bot.telegram.sendMessage(BOT_CHAT, "Tentando realizar o lucro...");
              let priceBTC = await bc.ticker();
              let { BRL, BTC } = await bc.balance();
              let lucroRealizado = await realizarLucro(BTC)
              if (lucroRealizado) {
                bot.telegram.sendMessage(BOT_CHAT, "ok! Lucro realizado", replyMarkup);
                inicializarSaldo();
                logger.info(`Lucro realizado. Valor: ${BTC}`)
              }
            } catch (error) {
              //imprimirMensagem(`Erro ao tentar realizar lucro: ${JSON.stringify(error)}`);
              logger.error(`${JSON.stringify(error)}`)
            }
          }
          operando = false
        }

      } else {
        imprimirMensagem('Aguardando...');
      }
    } else {
      imprimirMensagem('Operando! Aguardando conclusão...');
    }
  } else {
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

const replyMarkup = Extra.markup(Markup.inlineKeyboard([
  Markup.callbackButton('\u{1F51B} Iniciar Robô', 'iniciar'),
  Markup.callbackButton('\u{1F6D1} Parar Robô', 'parar'),
  Markup.callbackButton('\u{1F4BE} Atualizar Saldo', 'restart'),
  Markup.callbackButton('\u{1F9FE} Extrato', 'extrato'),
  Markup.callbackButton('\u{1F4D6} Ajuda', 'ajuda')
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
  <b>\u{1F4BE} Atualizar Saldo:</b> Atualiza o saldo no extrato.\n
  <b>\u{1F9FE} Extrato:</b> Extrato com o saldo, valor de operação, lucro, etc.
  ============
  `, replyMarkup)
});

//exibe o relatório com o extrato contendo saldo, lucro, tempo de operação, etc.
bot.action('extrato', ctx => {
  logger.info('Comando Extrato executado')
  checkExtrato();
});

//atualiza o saldo de operação
bot.action('restart', ctx => {
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

//---------------------FIM BOT TELEGRAM-----------------------

// -- UTILITY FUNCTIONS --

function percent(value1, value2) {
  return (Number(value2) / Number(value1) - 1) * 100;
}

function lucroreal(value1, value2) {
  return (Number(value2) / Number(value1)) * 100;
}

function imprimirMensagem(message, throwError = false) {
  console.log(`[${play ? `ROBÔ EM OPERAÇÃO` : `ROBÔ PARADO`}] - ${message}`);
  if (throwError) {
    throw new Error(message);
  }
}

//---------------------AGENDAMENTO API TELEGRAM-----------------------

// Envia uma mensagem a cada 24h

cron.schedule("33 18 * * *", () => {
  try {
    //shell.exec('service ntp stop');
    //shell.exec('service ntp start');
    //inicializarSaldo()    
    bot.telegram.sendMessage(BOT_CHAT, `\u{1F603} O bot está ativo e monitorando o mercado!`)
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