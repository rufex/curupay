let api = require("@actual-app/api");
const fs = require("fs");
const os = require("os");

const mappings = JSON.parse(fs.readFileSync("./mappings.json", "utf-8"));
const openAccounts: string[] = [];
const generatedTxs: string[] = [];
const processedTxIds = new Set<string>();

const COL_WIDTH = 80;
const CURRENCY = "EUR";

const dataDirPath = os.homedir() + "/.local/share/actual";
fs.mkdirSync(dataDirPath, { recursive: true });

type Account = {
  id: string;
  name: string;
};

type Category = {
  id: string;
  name: string;
};

type Transaction = {
  id: string;
  account: string;
  category: string;
  date: string;
  amount: number;
  payee: string;
  notes: string;
  transfer_id: string;
  subtransactions: Transaction[];
  is_parent: boolean;
  is_child: boolean;
};

type Payee = {
  id: string;
  name: string;
};

type ActualData = {
  transactions: Transaction[];
  accounts: Account[];
  categories: Category[];
  payees: Payee[];
};

(async () => {
  validateEnv();

  await api.init({
    dataDir: dataDirPath,
    serverURL: process.env.ACTUAL_SERVER_URL || "http://localhost:5006",
    password: process.env.ACTUAL_PASSWORD,
  });

  if (process.env.ACTUAL_ENCRYPTION_PASSWORD) {
    await api.downloadBudget(process.env.ACTUAL_SYNC_ID, {
      password: process.env.ACTUAL_ENCRYPTION_PASSWORD,
    });
  } else {
    await api.downloadBudget(process.env.ACTUAL_SYNC_ID);
  }

  const actualData: ActualData = await fetchActualData();

  await processTransactions(actualData);

  await generateBalances(actualData.accounts);

  await saveTransactionsToFile();

  await api.shutdown();
})();

function validateEnv() {
  // TODO: handle https certificate: https://actualbudget.org/docs/api/#self-signed-https-certificates
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  const requiredEnvVars = ["ACTUAL_PASSWORD", "ACTUAL_SYNC_ID"];
  for (const varName of requiredEnvVars) {
    if (!process.env[varName]) {
      throw new Error(
        `Environment variable ${varName} is required but not set.`,
      );
    }
  }
}

// Every account and category should have a mapped named
function validateMappings(actualData: ActualData) {
  const accountNames = actualData.accounts.map((acc) => acc.name);
  const categoryNames = actualData.categories.map((cat) => cat.name);
  let missingMappings = false;

  for (const accountName of accountNames) {
    if (!mappings["accounts"][accountName]) {
      console.warn(`[Account] "${accountName}" has no mapped account name`);
      missingMappings = true;
    }
  }

  for (const categoryName of categoryNames) {
    if (!mappings["categories"][categoryName]) {
      console.warn(`[Category] "${categoryName}" has no mapped category name`);
      missingMappings = true;
    }
  }

  if (missingMappings) {
    throw new Error(
      "Some accounts or categories are missing mapped names. Please update mappings.json and try again.",
    );
  }
}

async function processTransactions(actualData: ActualData) {
  validateMappings(actualData);

  for (const transaction of actualData.transactions) {
    if (processedTxIds.has(transaction.id)) {
      console.debug(
        `Transaction ${transaction.id} has already been processed. Skipping.`,
      );
      continue;
    }

    // Split transaction
    if (
      transaction.is_parent == true &&
      transaction.subtransactions &&
      transaction.subtransactions.length > 0
    ) {
      processSplitTransactions(transaction, actualData);
    }

    // Expense/Income
    if (transaction.category) {
      processExpense(transaction, actualData);
    }

    // Transfer
    if (transaction.transfer_id) {
      processTransfer(transaction, actualData);
    }
  }
}

function identifyMappedAccount(
  transaction: Transaction,
  actualData: ActualData,
) {
  const account = actualData.accounts.find(
    (acc: Account) => acc.id === transaction.account,
  );

  if (!account?.name) {
    console.warn(`Transaction ${transaction.id} has missing account name.`);
    return;
  }

  const mappedAccountName = mappings["accounts"][account.name] || undefined;

  if (!mappedAccountName) {
    console.warn(`Account ${account.name} has no mapped account name`);
    return;
  }

  return mappedAccountName;
}

function identifyMappedCategory(
  transaction: Transaction,
  actualData: ActualData,
) {
  const category = actualData.categories.find(
    (cat: Category) => cat.id === transaction.category,
  );

  if (!category?.name) {
    console.warn(`Transaction ${transaction.id} has missing category name.`);
    return;
  }

  const mappedCategoryName = mappings["categories"][category.name] || undefined;

  if (!mappedCategoryName) {
    console.warn(`Category ${category.name} has no mapped category name`);
    return;
  }

  return mappedCategoryName;
}

function identifyPayee(transaction: Transaction, actualData: ActualData) {
  const payee = actualData.payees.find(
    (p: Payee) => p.id === transaction.payee,
  );

  if (!payee?.name) {
    console.debug(`Transaction ${transaction.id} has missing payee name.`);
    return;
  }

  return payee.name;
}

function identifyRelatedTransaction(
  transaction: Transaction,
  actualData: ActualData,
) {
  const relatedTx = actualData.transactions.find(
    (t: Transaction) => t.id === transaction.transfer_id,
  );

  if (!relatedTx) {
    // #TODO: It may be a split transaction?
    console.warn(
      `Transaction ${transaction.id} has transfer_id ${transaction.transfer_id} but no related transaction was found.`,
    );
    return;
  }

  return relatedTx;
}

function processSplitTransactions(
  transaction: Transaction,
  actualData: ActualData,
) {
  // About Split Transactions:
  // There is the main transaction linked to an account
  // There are subtransactions that could be either linked to a category or a transfer
  // All subtransactions sum up to the amount of the main transaction
  // We need to create a unique multiple txn including all subtransactions balanced against the main transaction account

  const mainAccountName = identifyMappedAccount(transaction, actualData);
  if (!mainAccountName) return;
  openAccount(mainAccountName, transaction.date);

  const mainPayeeName = identifyPayee(transaction, actualData) || "";

  let comment = `; actual-tx-id:${transaction.id}`;
  let mainNote =
    transaction.notes != "" && transaction.notes != null
      ? ` ; ${transaction.notes}`
      : "";

  let lines = "";
  for (const subTx of transaction.subtransactions) {
    comment += `\n; actual-tx-id:${subTx.id}`;
    const subNote =
      subTx.notes != "" && subTx.notes != null ? ` ; ${subTx.notes}` : "";

    const amount = (-subTx.amount / 100).toFixed(2);
    let destName;

    if (subTx.category) {
      // Expense
      const mappedCategoryName = identifyMappedCategory(subTx, actualData);
      if (!mappedCategoryName) return;

      destName = mappedCategoryName;
    } else if (subTx.transfer_id) {
      // Transfer
      const matchingTx = identifyRelatedTransaction(subTx, actualData);
      if (!matchingTx) return;

      const mappedTransferAccountName = identifyMappedAccount(
        matchingTx,
        actualData,
      );
      if (!mappedTransferAccountName) return;

      destName = mappedTransferAccountName;
    } else {
      console.warn(
        `SubTx ${subTx.id} is missing both category and transfer_id. Skipping.`,
      );
      return;
    }

    openAccount(destName, subTx.date);
    lines += `  ${destName.padEnd(COL_WIDTH)} ${amount} ${CURRENCY}${subNote}\n`;
  }

  if (!lines) {
    console.warn(
      `Split transaction ${transaction.id} has no valid subtransactions. Skipping.`,
    );
    return;
  }

  const info = `${transaction.date} txn "${mainPayeeName}"`;
  const mainAmount = (transaction.amount / 100).toFixed(2);
  const mainLine = `  ${mainAccountName.padEnd(COL_WIDTH)} ${mainAmount} ${CURRENCY}${mainNote}\n`;
  const tx = `\n${comment}\n${info}\n${mainLine}${lines}`;

  processedTxIds.add(transaction.id);
  transaction.subtransactions.forEach((subTx) => processedTxIds.add(subTx.id));

  generatedTxs.push(tx);
}

function processExpense(transaction: Transaction, actualData: ActualData) {
  const mappedCategoryName = identifyMappedCategory(transaction, actualData);
  if (!mappedCategoryName) return;
  openAccount(mappedCategoryName, transaction.date);

  const mappedAccountName = identifyMappedAccount(transaction, actualData);
  if (!mappedAccountName) return;
  openAccount(mappedAccountName, transaction.date);

  const accountAmount = (transaction.amount / 100).toFixed(2);
  const categoryAmount = (-transaction.amount / 100).toFixed(2);

  const payeeName = identifyPayee(transaction, actualData) || "";

  const comment = `; actual-tx-id:${transaction.id}`;
  const info = `${transaction.date} txn "${payeeName}" "${transaction.notes || ""}"`;
  const line1 = `  ${mappedAccountName.padEnd(COL_WIDTH)}  ${accountAmount} ${CURRENCY}`;
  const line2 = `  ${mappedCategoryName.padEnd(COL_WIDTH)} ${categoryAmount} ${CURRENCY}`;
  const tx = `\n${comment}\n${info}\n${line1}\n${line2}\n`;

  processedTxIds.add(transaction.id);

  generatedTxs.push(tx);
}

function processTransfer(transaction: Transaction, actualData: ActualData) {
  const matchingTx = identifyRelatedTransaction(transaction, actualData);
  if (!matchingTx) return;

  const mappedAccountName = identifyMappedAccount(transaction, actualData);
  if (!mappedAccountName) return;
  openAccount(mappedAccountName, transaction.date);

  const mappedTransferAccountName = identifyMappedAccount(
    matchingTx,
    actualData,
  );
  if (!mappedTransferAccountName) return;
  openAccount(mappedTransferAccountName, matchingTx.date);

  const amountA = (transaction.amount / 100).toFixed(2);
  const amountB = (matchingTx.amount / 100).toFixed(2);

  const note = transaction.notes || matchingTx.notes || "Transfer";

  const comment = `; actual-tx-id:${transaction.id}\n; actual-tx-id:${matchingTx.id}`;
  const info = `${transaction.date} txn "${note}"`;
  const line1 = `  ${mappedAccountName.padEnd(COL_WIDTH)}  ${amountA} ${CURRENCY}`;
  const line2 = `  ${mappedTransferAccountName.padEnd(COL_WIDTH)} ${amountB} ${CURRENCY}`;
  const tx = `\n${comment}\n${info}\n${line1}\n${line2}\n`;

  processedTxIds.add(transaction.id);
  processedTxIds.add(matchingTx.id);

  generatedTxs.push(tx);
}

function openAccount(accountName: string, date: string) {
  if (openAccounts.includes(accountName)) return;

  openAccounts.push(accountName);

  const txn = `\n${date} open ${accountName.padEnd(COL_WIDTH)} ${CURRENCY}\n`;

  generatedTxs.push(txn);
}

async function saveTransactionsToFile() {
  const filePath = "./transactions.beancount";
  fs.writeFileSync(filePath, generatedTxs.join(""), "utf-8");
  console.log(`Generated transactions saved to ${filePath}`);
}

async function fetchActualData(): Promise<ActualData> {
  let transactions = (await api.getTransactions()) as Transaction[];
  transactions.reverse(); // process transactions in chronological order
  const accounts = (await api.getAccounts()) as Account[];
  const categories = (await api.getCategories()) as Category[];
  const payees = (await api.getPayees()) as Payee[];

  return {
    transactions,
    accounts,
    categories,
    payees,
  };
}

async function generateBalances(accounts: Account[]) {
  for (const account of accounts) {
    const mappedAccountName = mappings["accounts"][account.name] || undefined;
    if (!mappedAccountName) {
      console.warn(
        `Account ${account.name} has no mapped account name. Skipping balance generation.`,
      );
      continue;
    }

    const accountBalance = await api.getAccountBalance(account.id);
    const balanceAmount = (accountBalance / 100).toFixed(2);
    const today = new Date().toISOString().split("T")[0];

    const comment = `; actual-account-id:${account.id}`;
    const info = `${today} balance ${mappedAccountName.padEnd(COL_WIDTH)} ${balanceAmount} ${CURRENCY}`;
    const tx = `\n${comment}\n${info}\n`;

    generatedTxs.push(tx);
  }
}
