export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super('NOT_FOUND', 404, message);
  }
}

export class InsufficientBalanceError extends AppError {
  constructor(walletId: string, balance: number, requested: number) {
    super(
      'INSUFFICIENT_BALANCE',
      422,
      `Wallet ${walletId} balance ${balance} is less than requested ${requested}`,
    );
  }
}

export class CurrencyMismatchError extends AppError {
  constructor(walletCurrency: string, requestedCurrency: string) {
    super(
      'CURRENCY_MISMATCH',
      422,
      `Wallet currency is ${walletCurrency}; request specified ${requestedCurrency}`,
    );
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super('VALIDATION_ERROR', 400, message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super('CONFLICT', 409, message);
  }
}
