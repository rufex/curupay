# Curupay

Export Actual Budget transactions to Beancount format for double-entry accounting.

## What It Does

Curupay connects to your Actual Budget sync server, fetches all your transactions, accounts, and categories, and converts them to Plain Text Accounting format (following Beancount syntax).

## Why?

It was designed to serve as a simple starting point to plain text accounting for those long time users of Actual Budget.
To be able to easily generate your transactions, and be ready to start evaluating if you want to switch or not.


## Prerequisites

- Node.js and npm
- An Actual Budget instance with sync server
- Actual Budget sync credentials (password and sync ID)

## Installation

```bash
git clone https://github.com/rufex/curupay.git
cd curupay
npm install
```

## Configuration

### 1. Create mappings file

Copy the example mappings file:

```bash
cp mappings.json.example mappings.json
```

Edit `mappings.json` to map your Actual Budget accounts and categories to Beancount account paths:

```json
{
  "accounts": {
    "Checking Account": "Assets:Bank:Checking",
    "Cash": "Assets:Cash:EUR"
  },
  "categories": {
    "Groceries": "Expenses:Food:Groceries",
    "Salary": "Income:Salary"
  }
}
```

In plain text accounting, both accounts and categories are represented by accounts only.
Note that the mapped accounts should follow Beancount's accounts structure. For more details look at their [documentation](https://beancount.github.io/docs/beancount_cheat_sheet.html)

### 2. Set environment variables

Export the required environment variables for Actual Budget sync credentials:

```bash
ACTUAL_PASSWORD=your-actual-password
ACTUAL_SYNC_ID=your-sync-id
ACTUAL_SERVER_URL=https://your-server-url  # Optional, defaults to http://localhost:5006
ACTUAL_E2E_PASSWORD=your-e2e-password      # Optional, if using end-to-end encryption
```

## Usage

Compile the TypeScript code:

```bash
npm run compile
```

Run the export:

```bash
npm start
```

## Output

The tool generates a unique file named `transactions.beancount` containing:

- Account opening directives for all accounts
- All transactions in Beancount format with proper double-entry bookkeeping
- Balance assertions for account reconciliation (generated based on the last transaction date on Actual Budget)
- Transaction IDs as comments for cross-referencing with Actual Budget

## Transaction Types

Curupay handles three types of transactions:

- **Incomes and Expenses**: Regular spendings and incomes (debit account, credit expense category)
- **Transfers**: Account-to-account movements (debit destination, credit source)
- **Split transactions**: Transactions with multiple subtransactions across different categories

## Next ?

Beancount documentation is extensive and there are many tools in the ecosystem to explore. Read more at:

- https://beancount.github.io/docs/index.html
- https://plaintextaccounting.org/

