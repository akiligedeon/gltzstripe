import { Stripe } from "stripe";
import { getStripeAmountFromSaleorMoney } from "./currencies";
import {
  TransactionFlowStrategyEnum,
  type TransactionProcessSessionEventFragment,
  type TransactionInitializeSessionEventFragment,
} from "generated/graphql";
import { invariant } from "@/lib/invariant";
import type { TransactionInitializeSessionResponse } from "@/schemas/TransactionInitializeSession/TransactionInitializeSessionResponse.mjs";
import { InvalidSecretKeyError, RestrictedKeyNotSupportedError } from "@/errors";
import { unpackPromise } from "@/lib/utils";
import { createLogger, redactError } from "@/lib/logger";

const getStripeApiClient = (secretKey: string) => {
  const stripe = new Stripe(secretKey, {
    apiVersion: "2022-11-15",
    typescript: true,
    httpClient: Stripe.createFetchHttpClient(fetch),
  });
  return stripe;
};

export const validateStripeKeys = async (secretKey: string, publishableKey: string) => {
  const logger = createLogger({}, { msgPrefix: "[validateStripeKeys] " });

  if (secretKey.startsWith("rk_")) {
    // @todo remove this once restricted keys are supported
    // validate that restricted keys have required permissions
    throw new RestrictedKeyNotSupportedError("Restricted keys are not supported");
  }

  {
    const stripe = getStripeApiClient(secretKey);
    const [intentsError] = await unpackPromise(stripe.paymentIntents.list({ limit: 1 }));

    if (intentsError) {
      logger.error({ error: redactError(intentsError) }, "Invalid secret key");
      if (intentsError instanceof Stripe.errors.StripeError) {
        throw new InvalidSecretKeyError("Provided secret key is invalid");
      }
      throw new InvalidSecretKeyError("There was an error while checking secret key");
    }
  }

  {
    // https://stackoverflow.com/a/61001462/704894
    const stripe = getStripeApiClient(publishableKey);
    const [tokenError] = await unpackPromise(
      stripe.tokens.create({
        pii: { id_number: "test" },
      }),
    );
    if (tokenError) {
      logger.error({ error: redactError(tokenError) }, "Invalid publishable key");
      if (tokenError instanceof Stripe.errors.StripeError) {
        throw new InvalidSecretKeyError("Provided publishable key is invalid");
      }
      throw new InvalidSecretKeyError("There was an error while checking publishable key");
    }
  }
};

export const getEnvironmentFromKey = (secretKeyOrPublishableKey: string) => {
  return secretKeyOrPublishableKey.startsWith("sk_live_") ||
    secretKeyOrPublishableKey.startsWith("pk_live_") ||
    secretKeyOrPublishableKey.startsWith("rk_live_")
    ? "live"
    : "test";
};

export const transactionSessionInitializeEventToStripeCreate = (
  event: TransactionInitializeSessionEventFragment,
): Stripe.PaymentIntentCreateParams => {
  const data = event.data as Partial<Stripe.PaymentIntentCreateParams>;

  return {
    ...data,
    amount: getStripeAmountFromSaleorMoney({
      amount: event.sourceObject.total.gross.amount,
      currency: event.sourceObject.total.gross.currency,
    }),
    currency: event.sourceObject.total.gross.currency,
    automatic_payment_methods: {
      enabled: true,
    },
    capture_method:
      event.action.actionType === TransactionFlowStrategyEnum.Charge ? "automatic" : "manual",
    metadata: {
      ...data.metadata,
      transactionId: event.transaction.id,
      channelId: event.sourceObject.channel.id,
      ...(event.sourceObject.__typename === "Checkout" && { checkoutId: event.sourceObject.id }),
      ...(event.sourceObject.__typename === "Order" && { orderId: event.sourceObject.id }),
    },
  };
};

export const transactionSessionProcessEventToStripeUpdate = (
  event: TransactionInitializeSessionEventFragment | TransactionProcessSessionEventFragment,
): Stripe.PaymentIntentUpdateParams => {
  const data = event.data as Partial<Stripe.PaymentIntentUpdateParams>;

  return {
    ...data,
    amount: getStripeAmountFromSaleorMoney({
      amount: event.sourceObject.total.gross.amount,
      currency: event.sourceObject.total.gross.currency,
    }),
    currency: event.sourceObject.total.gross.currency,
    capture_method:
      event.action.actionType === TransactionFlowStrategyEnum.Charge ? "automatic" : "manual",
    metadata: {
      ...data.metadata,
      transactionId: event.transaction.id,
      channelId: event.sourceObject.channel.id,
      ...(event.sourceObject.__typename === "Checkout" && { checkoutId: event.sourceObject.id }),
      ...(event.sourceObject.__typename === "Order" && { orderId: event.sourceObject.id }),
    },
  };
};

export const stripePaymentIntentToTransactionResult = (
  transactionFlowStrategy: TransactionFlowStrategyEnum,
  stripePaymentIntent: Stripe.PaymentIntent,
): TransactionInitializeSessionResponse["result"] => {
  const stripeResult = stripePaymentIntent.status;
  const prefix =
    transactionFlowStrategy === TransactionFlowStrategyEnum.Authorization
      ? "AUTHORIZATION"
      : transactionFlowStrategy === TransactionFlowStrategyEnum.Charge
      ? "CHARGE"
      : /* c8 ignore next */
        null;
  invariant(prefix, `Unsupported transactionFlowStrategy: ${transactionFlowStrategy}`);

  switch (stripeResult) {
    case "requires_payment_method":
    case "processing":
      return `${prefix}_REQUESTED`;
    case "requires_action":
    case "requires_capture":
    case "requires_confirmation":
      return `${prefix}_ACTION_REQUIRED`;
    case "canceled":
      return `${prefix}_FAILURE`;
    case "succeeded":
      return `${prefix}_SUCCESS`;
  }
};

export const initializeStripePaymentIntent = ({
  paymentIntentCreateParams,
  secretKey,
}: {
  paymentIntentCreateParams: Stripe.PaymentIntentCreateParams;
  secretKey: string;
}) => {
  const stripe = getStripeApiClient(secretKey);
  return stripe.paymentIntents.create(paymentIntentCreateParams);
};

export const updateStripePaymentIntent = ({
  intentId,
  paymentIntentUpdateParams,
  secretKey,
}: {
  intentId: string;
  paymentIntentUpdateParams: Stripe.PaymentIntentUpdateParams;
  secretKey: string;
}) => {
  const stripe = getStripeApiClient(secretKey);
  return stripe.paymentIntents.update(intentId, paymentIntentUpdateParams);
};

export const getStripeExternalUrlForIntentId = (intentId: string) => {
  const externalUrl = `https://dashboard.stripe.com/payments/${encodeURIComponent(intentId)}`;
  return externalUrl;
};
