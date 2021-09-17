import Biscoint from 'biscoint-api-node';
import _ from 'lodash';
import { Telegraf, Markup } from 'telegraf';
import moment from 'moment';
import axios from 'axios';
import Bottleneck from "bottleneck";

// env variables
let apiKey = process.env.API_KEY
let apiSecret = process.env.API_SECRET
let amount = process.env.AMOUNT || 300
let amountCurrency = process.env.AMOUNT_CURRENCY || "BRL"
let initialBuy = process.env.INITIAL_BUY || true
let minProfitPercent = process.env.MIN_PROFIT_PERCENT || 0.03
let intervalSeconds = process.env.INTERVAL_SECONDS || null
let play = process.env.SIMULATION || true
let executeMissedSecondLeg = process.env.EXECUTE_MISSED_SECOND_LEG || true
let token = process.env.BOT_TOKEN
let botchat = process.env.BOT_CHAT
let dataInicial = process.env.DATA_INICIAL || "01/09/2021"
let valorInicial = process.env.VALOR_INICIAL || 300
let botId = process.env.BOT_ID || "bot_1"
let port = process.env.PORTA || 80
let multibot = process.env.MULTIBOT || true
let accumulateBTC = process.env.ACCUMULATE_BTC || false

// global variables
let bc, lastTrade = 0, isQuote, balances;
let operando = false

// Limiter Bottleneck
const limiter = new Bottleneck({
  reservoir: 30,
  reservoirRefreshAmount: 30,
  reservoirRefreshInterval: 60 * 1000,
  maxConcurrent: 1,
});

// Moeda para acumular
// if (amountCurrency === 'BRL') {
//   acbrl = true
// } else {
//   accumulateBTC = true
// }

// multibot
let robo = new Object()
robo.id = botId
let botStatus = false

// Initializes the Biscoint API connector object.
const init = () => {
  if (!apiKey) {
    handleMessage('You must specify "apiKey" in config.json', 'error', true);
  }
  if (!apiSecret) {
    handleMessage('You must specify "apiSecret" in config.json', 'error', true);
  }

  amountCurrency = _.toUpper(amountCurrency);
  if (!['BRL', 'BTC'].includes(amountCurrency)) {
    handleMessage('"amountCurrency" must be either "BRL" or "BTC". Check your config.json file.', 'error', true);
  }

  if (isNaN(amount)) {
    handleMessage(`Invalid amount "${amount}. Please specify a valid amount in config.json`, 'error', true);
  }

  isQuote = amountCurrency === 'BRL';

  bc = new Biscoint({
    apiKey: apiKey,
    apiSecret: apiSecret
  });
};

// Telegram
if (token === undefined) {
  throw new Error('BOT_TOKEN must be provided!');
}

const bot = new Telegraf(token)

//bot.use(Telegraf.log())

const keyboard = Markup.inlineKeyboard(
  [
    Markup.button.callback('\u{1F51B} Iniciar Robô', 'startbot'),
    Markup.button.callback('\u{1F6D1} Parar Robô', 'stopbot'),
   // Markup.button.callback('\u{1F680} Acumular BTC', 'acbtc'),
    Markup.button.callback('\u{1F4BE} Atualizar Saldo', 'restart'),
    Markup.button.callback('\u{1F9FE} Extrato', 'extrato'),
    Markup.button.callback('\u{1F4D6} Ajuda', 'help'),
    Markup.button.url('₿', 'https://www.biscoint.io')
  ], { columns: 2 })

// Commands Telegram
bot.action('startbot', (ctx) => {
  if (play == true) {
    ctx.reply('\u{1F51B} O bot já está em operação', keyboard);
  } else {
    play = true
    ctx.replyWithMarkdown(`\u{1F911} Iniciando Trades...\n 🚀 *Modo simulação:* desativado`, keyboard);
  }
}
);

bot.action('stopbot', (ctx) => {
  if (play == false) {
    ctx.reply('\u{1F6D1} O bot já está pausado', keyboard);
  } else {
    play = false
    ctx.replyWithMarkdown(`\u{1F6D1} Ok! Robô parado para operações...\n ✈️ *Modo simulação:* ativado`, keyboard);
  }
}
);

// Acumular BTC
bot.action('acbtc', async (ctx) => {
  handleMessage('Acumulando BTC.')
  accumulateBTC = true
  handleMessage('acbtc:', accumulateBTC)
  await ctx.reply('\u{1F680} Acumulando BTC.');
  await checkBalances();
});

bot.action('restart', async (ctx) => {
  await ctx.reply('Atualizando saldo inicial...');
  try {
    inicializarSaldo();
    await ctx.reply('Ok! Saldo inicial atualizado.', keyboard);
  } catch (error) {
    handleMessage(`Comando Restart:
    ${error}`)
    await ctx.reply(error);
  }
});

bot.action('extrato', async (ctx) => {
  await checkBalances();
}
);

bot.action('help', (ctx) => {
  ctx.replyWithMarkdown(
    `*Comandos disponíveis:* 
    ============  
    *\u{1F51B} Iniciar Robô:* Incia as operações. É o padrão no primeiro acesso.\n
    *\u{1F6D1} Parar Robô:* Para as operações. Demais comandos ficam disponíveis.\n
    *\u{1F9FE} Extrato:* Extrato com o saldo, valor de operação, lucro, etc.
    ============
    `, keyboard)
}
);

bot.hears(/^\/vender (.+)$/, async (ctx) => {
  let valor = ctx.match[1];
  await realizarLucro(valor)
}
)

bot.start((ctx) => ctx.reply('\u{1F911} Iniciando trades!', keyboard));

// Checks that the balance necessary for the first operation is sufficient for the configured 'amount'.
const checkBalances = async () => {
  balances = await bc.balance();
  const { BRL, BTC } = balances;

  // Extrato
  let lucro = await bc.ticker();
  let valorTotal = BRL;
  let moment1 = moment();
  let moment2 = moment(dataInicial, "DD/MM/YYYY");
  let dias = moment1.diff(moment2, 'days');
  let lucroRealizado = percent(valorInicial, valorTotal);
  await bot.telegram.sendMessage(botchat,
    `\u{1F911} Balanço:
    <b>Status</b>: ${play ? `\u{1F51B} Robô operando.` : `\u{1F6D1} Robô parado.`} 
    <b>Acumulando</b>: ${accumulateBTC ? `\u{1F680} BTC.` : `\u{1F4B5} Real.`} 
    Data Inicial: ${moment2.format("DD/MM/YYYY")} 
    Dias Operando: ${dias}
    Depósito Inicial: R$ ${valorInicial}  
    <b>BRL:</b> ${BRL} 
    <b>BTC:</b> ${BTC} (R$ ${(lucro.last * BTC).toFixed(2)})
    Operando com: R$ ${amount}
    ============                                                
    Lucro Parcial: ${lucroreal(valorTotal, lucro.last * BTC).toFixed(2)}% (R$ ${(lucro.last * BTC).toFixed(2)})
    Lucro Realizado: ${lucroRealizado.toFixed(2)}% (R$ ${(valorTotal - valorInicial).toFixed(2)});
    <b>Lucro Total:</b> ${(lucroreal(valorTotal, lucro.last * BTC) + lucroRealizado).toFixed(2)}% (R$ ${(lucro.last * BTC + (valorTotal - valorInicial)).toFixed(2)})
    ============`, { parse_mode: "HTML" });
  await bot.telegram.sendMessage(botchat, "Extrato executado!", keyboard)
  // Fim Extrato

  handleMessage(`Balances:  BRL: ${BRL} - BTC: ${BTC} `);

  const nAmount = Number(amount);
  let amountBalance = isQuote ? BRL : BTC;
  if (nAmount > Number(amountBalance)) {
    handleMessage(
      `Amount ${amount} is greater than the user's ${isQuote ? 'BRL' : 'BTC'} balance of ${amountBalance}`);
    amount = amountBalance // define o amount com o saldo da corretora
    handleMessage(amount)
  }
};

// Restart balance
const inicializarSaldo = async () => {
  try {
    let { BRL, BTC } = await bc.balance();
    amount = BRL
  } catch (error) {
    handleMessage(JSON.stringify(error));
  }
}

// Checks that the configured interval is within the allowed rate limit.
const checkInterval = async () => {
  const { endpoints } = await bc.meta();
  const { windowMs, maxRequests } = endpoints.offer.post.rateLimit;
  handleMessage(`Offer Rate limits: ${maxRequests} request per ${windowMs}ms.`);
  let minInterval = 2.0 * parseFloat(windowMs) / parseFloat(maxRequests) / 1000.0;

  if (!intervalSeconds) {
    intervalSeconds = minInterval;
    handleMessage(`Setting interval to ${intervalSeconds}s`);
  } else if (intervalSeconds < minInterval) {
    //handleMessage(`Interval too small (${intervalSeconds}s). Must be higher than ${minInterval.toFixed(1)}s`, 'error', false);
    handleMessage(`Interval too small (${intervalSeconds}s). Must be higher than ${minInterval.toFixed(1)}s`);
  }
};

let tradeCycleCount = 0;

// Executes an arbitrage cycle
async function trader() {
  if (play) {
    if (!operando) {
      let buyOffer
      let sellOffer
      let profit
      let profitBRL

      try {
        buyOffer = await bc.offer({
          amount,
          isQuote,
          op: 'buy',
        });

        sellOffer = await bc.offer({
          amount,
          isQuote,
          op: 'sell',
        });

        profit = percent(buyOffer.efPrice, sellOffer.efPrice);
        profitBRL = (amount * profit) / 100
        handleMessage(`Intervalo, em segundos, entre verificações de oportunidade de arbitragem: ${intervalSeconds}s`)
        handleMessage(`Variação de preço calculada: ${profit.toFixed(3)}%`);
        if (profit >= minProfitPercent) {
          //Inicia a operação e trava o bot para novas operações até o final da operação corrente, seja quando é realizado um lucro
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
            bot.telegram.sendMessage(botchat, `\u{1F911} Sucesso! Lucro: + ${profit.toFixed(3)}% \n R$ ${profitBRL.toFixed(2)}`, keyboard);
            handleMessage(`Sucesso! Lucro: + ${profit.toFixed(3)}% \n R$ ${profitBRL.toFixed(2)}`)
            let { BRL, BTC } = await bc.balance();
            //lucroAcumulado(profit).then(() => { }).catch(e => { handleMessage(e) });
            // Se acbtc for true, faz a venda proporcional
            if (accumulateBTC && BTC >= 0.001) {
              try {
                bot.telegram.sendMessage(botchat, "Tentando realizar o lucro...");
                let priceBTC = await bc.ticker();
                let valorAtual = (valorInicial / priceBTC.last).toFixed(8);
                let lucroRealizado = await realizarLucro(valorAtual)
                if (lucroRealizado) {
                  bot.telegram.sendMessage(botchat, "ok! Lucro realizado", keyboard);
                  inicializarSaldo();
                  handleMessage(`Lucro realizado. Valor: ${BTC}`)
                }
              } catch (error) {
                //imprimirMensagem(`Erro ao tentar realizar lucro: ${JSON.stringify(error)}`);
                handleMessage(`${JSON.stringify(error)}`)
              }
            } else if (BTC >= 0.001) {
              try {
                bot.telegram.sendMessage(botchat, "Tentando realizar o lucro...");
                let priceBTC = await bc.ticker();
                let { BRL, BTC } = await bc.balance();
                let lucroRealizado = await realizarLucro(BTC)
                if (lucroRealizado) {
                  bot.telegram.sendMessage(botchat, "ok! Lucro realizado", keyboard);
                  inicializarSaldo();
                  handleMessage(`Lucro realizado. Valor: ${BTC}`)
                }
              } catch (error) {
                //imprimirMensagem(`Erro ao tentar realizar lucro: ${JSON.stringify(error)}`);
                handleMessage(`${JSON.stringify(error)}`)
              }
            }
            //libera o robô para realizar novas operações
            operando = false

          } catch (error) {
            //imprimirMensagem(`Error on confirm offer: ${JSON.stringify(error)}`);
            handleMessage(`Erro ao confirmar a oferta: ${JSON.stringify(error)}`)
            bot.telegram.sendMessage(botchat, `${error.error}. ${error.details}`);
            // Se accumulateBTC for true, faz a venda proporcional
            if (accumulateBTC && BTC >= 0.001) {
              try {
                bot.telegram.sendMessage(botchat, "Tentando realizar o lucro...");
                let priceBTC = await bc.ticker();
                let valorAtual = (valorInicial / priceBTC.last).toFixed(8);
                let lucroRealizado = await realizarLucro(valorAtual)
                if (lucroRealizado) {
                  bot.telegram.sendMessage(botchat, "ok! Lucro realizado", keyboard);
                  inicializarSaldo();
                  handleMessage(`Lucro realizado. Valor: ${BTC}`)
                }
              } catch (error) {
                //imprimirMensagem(`Erro ao tentar realizar lucro: ${JSON.stringify(error)}`);
                handleMessage(`${JSON.stringify(error)}`)
              }
            } else if (BTC >= 0.001) {
              try {
                bot.telegram.sendMessage(botchat, "Tentando realizar o lucro...");
                let priceBTC = await bc.ticker();
                let { BRL, BTC } = await bc.balance();
                let lucroRealizado = await realizarLucro(BTC)
                if (lucroRealizado) {
                  bot.telegram.sendMessage(botchat, "ok! Lucro realizado", keyboard);
                  inicializarSaldo();
                  handleMessage(`Lucro realizado. Valor: ${BTC}`)
                }
              } catch (error) {
                //imprimirMensagem(`Erro ao tentar realizar lucro: ${JSON.stringify(error)}`);
                handleMessage(`${JSON.stringify(error)}`)
              }
            }
            operando = false
          }
        }
      } catch (error) {
        //imprimirMensagem(`Error on get offer': ${JSON.stringify(error)}`);
        handleMessage(`Erro ao obter oferta: ${JSON.stringify(error)}`)
        let { BRL, BTC } = await bc.balance();
        // Se accumulateBTC for true, faz a venda proporcional
        if (accumulateBTC && BTC >= 0.001) {
          try {
            bot.telegram.sendMessage(botchat, "Tentando realizar o lucro...");
            let priceBTC = await bc.ticker();
            let valorAtual = (valorInicial / priceBTC.last).toFixed(8);
            let lucroRealizado = await realizarLucro(valorAtual)
            if (lucroRealizado) {
              bot.telegram.sendMessage(botchat, "ok! Lucro realizado", keyboard);
              inicializarSaldo();
              handleMessage(`Lucro realizado. Valor: ${BTC}`)
            }
          } catch (error) {
            //imprimirMensagem(`Erro ao tentar realizar lucro: ${JSON.stringify(error)}`);
            handleMessage(`${JSON.stringify(error)}`)
          }
        } else if (BTC >= 0.001) {
          try {
            bot.telegram.sendMessage(botchat, "Tentando realizar o lucro...");
            let priceBTC = await bc.ticker();
            let { BRL, BTC } = await bc.balance();
            let lucroRealizado = await realizarLucro(BTC)
            if (lucroRealizado) {
              bot.telegram.sendMessage(botchat, "ok! Lucro realizado", keyboard);
              inicializarSaldo();
              handleMessage(`Lucro realizado. Valor: ${BTC}`)
            }
          } catch (error) {
            //imprimirMensagem(`Erro ao tentar realizar lucro: ${JSON.stringify(error)}`);
            handleMessage(`${JSON.stringify(error)}`)
          }
        }
        operando = false
      }


    } else {
      handleMessage('Operando! Aguardando conclusão...');
    }
  } else {
    handleMessage('Robô pausado pelo usuário... Para iniciar aperte o botão Iniciar Robô no Telegram.');
  }

}


// Starts trading, scheduling trades to happen every 'intervalSeconds' seconds.
const startTrading = async () => {
  handleMessage('Starting trades');
  bot.telegram.sendMessage(botchat, '\u{1F911} Iniciando trades!');
  await trader();
  setInterval(async () => {
    limiter.schedule(() => trader());
  }, intervalSeconds * 1000);
};

// -- UTILITY FUNCTIONS --
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
            amount = BRL
            resolve(true)
          } catch (error) {
            bot.telegram.sendMessage(botchat, `${error.error}. ${error.details}`);
            reject(false)
          }
        }
        else {
          bot.telegram.sendMessage(botchat, "Valor de venda abaixo do limite mínimo de 0.001");
          reject(false)
        }
      } catch (error) {
        bot.telegram.sendMessage(botchat, `${error.error}. ${error.details} `);
        reject(false)
      }
    })();
  })
}

function lucroreal(value1, value2) {
  return (Number(value2) / Number(value1)) * 100;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve(), ms));
}

function percent(value1, value2) {
  return (Number(value2) / Number(value1) - 1) * 100;
}

function handleMessage(message, level = 'info', throwError = false) {
  //console.log(`${new Date().toISOString()} [Biscoint BOT] [${level}] - ${message}`);
  console.log(`${new Date().toISOString()} [${play ? `ROBÔ EM OPERAÇÃO` : `ROBÔ PARADO`}] - ${message}`);
  if (throwError) {
    throw new Error(message);
  }
}

function imprimirMensagem(message, throwError = false) {
  console.log(`[${play ? `ROBÔ EM OPERAÇÃO` : `ROBÔ PARADO`}] - ${message}`);
  if (throwError) {
    throw new Error(message);
  }
}

// performs initialization, checks and starts the trading cycles.
async function start() {
  init();
  await checkBalances();
  await inicializarSaldo();
  await checkInterval();
  await startTrading();
}

bot.launch()

start().catch(e => handleMessage(JSON.stringify(e), 'error'));
