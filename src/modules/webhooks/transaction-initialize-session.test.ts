import { describe, it, expect } from "vitest";

import { TransactionInitializeSessionWebhookHandler } from "./transaction-initialize-session";
import {
  createMockTransactionInitializeSessionEvent,
  createMockTransactionInitializeSessionSourceObjectCheckout,
  createMockTransactionInitializeSessionSourceObjectOrder,
} from "./__tests__/utils";
import { setupRecording } from "@/__tests__/polly";
import { testEnv } from "@/__tests__/test-env.mjs";

import { TransactionFlowStrategyEnum } from "generated/graphql";

describe("TransactionInitializeSessionWebhookHandler", () => {
  setupRecording({});

  describe.each([
    {
      name: "Checkout",
      getSourceObject: createMockTransactionInitializeSessionSourceObjectCheckout,
    },
    { name: "Order", getSourceObject: createMockTransactionInitializeSessionSourceObjectOrder },
  ])("$name", ({ getSourceObject }) => {
    it.each([
      {
        title: "should work authorization",
        data: {
          automatic_payment_methods: {
            enabled: true,
          },
        },
        result: "AUTHORIZATION_ACTION_REQUIRED",
        amount: 99.99 + 123.0,
        actionType: TransactionFlowStrategyEnum.Authorization,
      },
      {
        title: "should work charge",
        data: {
          automatic_payment_methods: {
            enabled: true,
          },
        },
        result: "CHARGE_ACTION_REQUIRED",
        amount: 99.99 + 123.0,
        actionType: TransactionFlowStrategyEnum.Charge,
      },
    ])("$title", async ({ title, data, result, amount, actionType }) => {
      const event = await createMockTransactionInitializeSessionEvent({
        data,
        sourceObject: getSourceObject(),
        action: {
          actionType,
        },
      });
      const initializeResult = await TransactionInitializeSessionWebhookHandler(
        event,
        testEnv.TEST_SALEOR_API_URL,
      );
      expect(initializeResult.data).toEqual(expect.any(Object));
      expect(initializeResult.result).toEqual(result);
      expect(initializeResult.amount).toEqual(amount);
      expect(initializeResult.data).toMatchSnapshot(
        {
          paymentIntent: {
            client_secret: expect.any(String),
          },
        },
        title,
      );
    });
  });
});
