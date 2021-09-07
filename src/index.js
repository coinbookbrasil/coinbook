import Biscoint from 'biscoint-api-node';
import _ from 'lodash';
import { Telegraf, Markup } from 'telegraf';
import moment from 'moment';

// env variables
let apiKey = process.env.API_KEY
let apiSecret = process.env.API_SECRET
let amount = process.env.AMOUNT || 300
let amountCurrency = process.env.AMOUNT_CURRENCY || "BRL"
let initialBuy = process.env.INITIAL_BUY || true
let minProfitPercent = process.env.MIN_PROFIT_PERCENT || 0.03
let intervalSeconds = process.env.INTERVAL_SECONDS || null
let simulation = process.env.SIMULATION || false
let executeMissedSecondLeg = process.env.EXECUTE_MISSED_SECOND_LEG || true
let token = process.env.BOT_TOKEN
let botchat = process.env.BOT_CHAT
let dataInicial = process.env.DATA_INICIAL || "01/09/2021"
let valorInicial = process.env.VALOR_INICIAL || 300

// global variables
let bc, lastTrade = 0, isQuote, balances;

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
    Markup.button.callback('\u{1F4BE} Atualizar Saldo', 'restart'),
    Markup.button.callback('\u{1F9FE} Extrato', 'extrato'),
    Markup.button.callback('\u{1F4D6} Ajuda', 'help'),
    Markup.button.url('₿', 'https://www.biscoint.io')
  ], { columns: 2 })

// Commands Telegram
bot.action('startbot', (ctx) => {
  if (simulation == false) {
    ctx.reply('\u{1F51B} O bot já está em operação', keyboard);
  } else {
    simulation = false
    ctx.replyWithMarkdown(`\u{1F911} Iniciando Trades...\n 🚀 *Modo simulação:* desativado`, keyboard);
  }
}
);

bot.action('stopbot', (ctx) => {
  if (simulation == true) {
    ctx.reply('\u{1F6D1} O bot já está pausado', keyboard);
  } else {
    simulation = true
    ctx.replyWithMarkdown(`\u{1F6D1} Ok! Robô parado para operações...\n ✈️ *Modo simulação:* ativado`, keyboard);
  }
}
);

bot.action('restart', async ctx => {
  await ctx.reply('Atualizando saldo inicial...');
  try {
    inicializarSaldo();
    await ctx.reply('Ok! Saldo inicial atualizado.', keyboard);
  } catch (error) {
    handleMessage(`Comando Restart: ${error}`)
    await ctx.reply('error');
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
    <b>Status</b>: ${!simulation ? `\u{1F51B} Robô operando.` : `\u{1F6D1} Robô parado.`} 
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
      `Amount ${amount} is greater than the user's ${isQuote ? 'BRL' : 'BTC'} balance of ${amountBalance}`,
      'error',
      false,
    );
    amount = amountBalance // define o amount com o saldo da corretora
  }
};

// Restart balance
const inicializarSaldo = async () => {
  try {
    let { BRL, BTC } = await bc.balance();
    amount = BRL
  } catch (error) {
    //imprimirMensagem(JSON.stringify(error));
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
    handleMessage(`Interval too small (${intervalSeconds}s). Must be higher than ${minInterval.toFixed(1)}s`, 'error', true);
  }
};

let tradeCycleCount = 0;

// Executes an arbitrage cycle
async function tradeCycle() {
  let startedAt = 0;
  let finishedAt = 0;

  tradeCycleCount += 1;
  const tradeCycleStartedAt = Date.now();

  handleMessage(`[${tradeCycleCount}] Ciclo de trader iniciado...`);

  try {

    startedAt = Date.now();

    const buyOffer = await bc.offer({
      amount,
      isQuote,
      op: 'buy',
    });

    finishedAt = Date.now();

    handleMessage(`[${tradeCycleCount}] Oferta de compra: ${buyOffer.efPrice} (${finishedAt - startedAt} ms)`);

    startedAt = Date.now();

    const sellOffer = await bc.offer({
      amount,
      isQuote,
      op: 'sell',
    });

    finishedAt = Date.now();

    handleMessage(`[${tradeCycleCount}] Oferta de venda: ${sellOffer.efPrice} (${finishedAt - startedAt} ms)`);

    const profit = percent(buyOffer.efPrice, sellOffer.efPrice);
    handleMessage(`[${tradeCycleCount}] Lucro calculado: ${profit.toFixed(3)}%`);
    handleMessage(`${!simulation ? `Robô operando.` : `Robô parado.`}`)
    handleMessage(`Intervalo, em segundos, entre verificações de oportunidade de arbitragem: ${intervalSeconds}s`)
    if (
      profit >= minProfitPercent
    ) {
      let firstOffer, secondOffer, firstLeg, secondLeg;
      try {
        if (initialBuy) {
          firstOffer = buyOffer;
          secondOffer = sellOffer;
        } else {
          firstOffer = sellOffer;
          secondOffer = buyOffer;
        }

        startedAt = Date.now();

        if (simulation) {
          handleMessage(`[${tradeCycleCount}] Executaria arbitragem se o modo de simulação não estivesse habilitado`);
        } else {
          firstLeg = await bc.confirmOffer({
            offerId: firstOffer.offerId,
          });

          secondLeg = await bc.confirmOffer({
            offerId: secondOffer.offerId,
          });
        }

        finishedAt = Date.now();

        lastTrade = Date.now();

        handleMessage(`[${tradeCycleCount}] Sucesso, lucro: + ${profit.toFixed(3)}% (${finishedAt - startedAt} ms)`);
        bot.telegram.sendMessage(botchat, `\u{1F911} Sucesso! Lucro: + ${profit.toFixed(3)}%`);
      } catch (error) {
        handleMessage(`[${tradeCycleCount}] Error on confirm offer: ${error.error}`, 'error');
        console.error(error);

        if (firstLeg && !secondLeg) {
          // probably only one leg of the arbitrage got executed, we have to accept loss and rebalance funds.
          try {
            // first we ensure the leg was not actually executed
            let secondOp = initialBuy ? 'sell' : 'buy';
            const trades = await bc.trades({ op: secondOp });
            if (_.find(trades, t => t.offerId === secondOffer.offerId)) {
              handleMessage(`[${tradeCycleCount}] The second leg was executed despite of the error. Good!`);
            } else if (!executeMissedSecondLeg) {
              handleMessage(
                `[${tradeCycleCount}] Only the first leg of the arbitrage was executed, and the ` +
                'executeMissedSecondLeg is false, so we won\'t execute the second leg.',
              );
            } else {
              handleMessage(
                `[${tradeCycleCount}] Only the first leg of the arbitrage was executed. ` +
                'Trying to execute it at a possible loss.',
              );
              secondLeg = await bc.offer({
                amount,
                isQuote,
                op: secondOp,
              });
              await bc.confirmOffer({
                offerId: secondLeg.offerId,
              });
              handleMessage(`[${tradeCycleCount}] The second leg was executed and the balance was normalized`);
              inicializarSaldo();
            }
          } catch (error) {
            handleMessage(
              `[${tradeCycleCount}] Fatal error. Unable to recover from incomplete arbitrage. Exiting.`, 'error',
            );
            //await sleep(500);
            //process.exit(1);
            try {
              let { BRL, BTC } = await bc.balance();
              if (BTC >= 0.001) {
                bot.telegram.sendMessage(botchat, "Não foi possível confirmar a venda de BTC. O BTC será vendido a mercado!");
                let lucroRealizado = await realizarLucro(BTC)
                if (lucroRealizado) {
                  bot.telegram.sendMessage(botchat, "Ok! Saldo em BTC foi vendido a mercado.");
                  inicializarSaldo();
                }
              }
            } catch (error) {
              bot.telegram.sendMessage(botchat, `${JSON.stringify(error)}`);
            }
          }
        }
      }
    }
  } catch (error) {
    handleMessage(`[${tradeCycleCount}] Error on get offer: ${error.error || error.message}`, 'error');
    console.error(error);
    try {
      let { BRL, BTC } = await bc.balance();
      if (BTC >= 0.001) {
        bot.telegram.sendMessage(botchat, "Não foi possível confirmar a venda de BTC. O BTC será vendido a mercado!");
        let lucroRealizado = await realizarLucro(BTC)
        if (lucroRealizado) {
          bot.telegram.sendMessage(botchat, "Ok! Saldo em BTC foi vendido a mercado.");
          inicializarSaldo();
        }
      }
    } catch (error) {
      bot.telegram.sendMessage(botchat, `${JSON.stringify(error)}`);
    }
  }

  const tradeCycleFinishedAt = Date.now();
  const tradeCycleElapsedMs = parseFloat(tradeCycleFinishedAt - tradeCycleStartedAt);
  const shouldWaitMs = Math.max(Math.ceil((intervalSeconds * 1000.0) - tradeCycleElapsedMs), 0);

  // handleMessage(`[${cycleCount}] Cycle took ${tradeCycleElapsedMs} ms`);

  // handleMessage(`[${cycleCount}] New cycle in ${shouldWaitMs} ms...`);

  setTimeout(tradeCycle, shouldWaitMs);
}

// Starts trading, scheduling trades to happen every 'intervalSeconds' seconds.
const startTrading = async () => {
  handleMessage('Starting trades');
  bot.telegram.sendMessage(botchat, '\u{1F911} Iniciando trades!');
  tradeCycle();
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
  console.log(`${new Date().toISOString()} [Biscoint BOT] [${level}] - ${message}`);
  if (throwError) {
    throw new Error(message);
  }
}

// performs initialization, checks and starts the trading cycles.
async function start() {
  init();
  await inicializarSaldo();
  await checkBalances();
  await checkInterval();
  await startTrading();
}

bot.launch()

start().catch(e => handleMessage(JSON.stringify(e), 'error'));
