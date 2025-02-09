import { NextResponse } from "next/server";
import { encode } from "gpt-tokenizer/model/gpt-4";
import { Pool, PoolClient } from "pg";
import { createClient } from "@vercel/postgres";
import { query, getClient } from "@/lib/db/client";
import { getModelInletCost } from "@/lib/utils/inlet-cost";

const isVercel = process.env.VERCEL === "1";

interface Message {
  role: string;
  content: string;
}

interface ModelPrice {
  id: string;
  name: string;
  input_price: number;
  output_price: number;
  per_msg_price: number;
}

type DbClient = ReturnType<typeof createClient> | Pool | PoolClient;

async function getModelPrice(modelId: string): Promise<ModelPrice | null> {
  const result = await query(
    `SELECT id, name, input_price, output_price, per_msg_price 
     FROM model_prices 
     WHERE id = $1`,
    [modelId]
  );

  if (result.rows[0]) {
    return result.rows[0];
  }

  // If no price is found in the database, use the default price
  const defaultInputPrice = parseFloat(
    process.env.DEFAULT_MODEL_INPUT_PRICE || "60"
  );
  const defaultOutputPrice = parseFloat(
    process.env.DEFAULT_MODEL_OUTPUT_PRICE || "60"
  );

  // Verify that the default price is a valid non-negative number
  if (
    isNaN(defaultInputPrice) ||
    defaultInputPrice < 0 ||
    isNaN(defaultOutputPrice) ||
    defaultOutputPrice < 0
  ) {
    return null;
  }

  return {
    id: modelId,
    name: modelId,
    input_price: defaultInputPrice,
    output_price: defaultOutputPrice,
    per_msg_price: -1, // Default to token-based pricing
  };
}

export async function POST(req: Request) {
  const client = (await getClient()) as DbClient;
  let pgClient: DbClient | null = null;

  try {
    // Get a dedicated transaction client
    if (isVercel) {
      pgClient = client;
    } else {
      pgClient = await (client as Pool).connect();
    }

    const data = await req.json();
    console.log("请求数据:", JSON.stringify(data, null, 2));
    const modelId = data.body.model;
    const userId = data.user.id;
    const userName = data.user.name || "Unknown User";

    // Start a transaction
    await query("BEGIN");

    // Get model price
    const modelPrice = await getModelPrice(modelId);
    if (!modelPrice) {
      throw new Error(`Fail to fetch price info of model ${modelId}`);
    }

    // Calculate tokens
    const lastMessage = data.body.messages[data.body.messages.length - 1];

    let inputTokens: number;
    let outputTokens: number;
    if (
      lastMessage.info &&
      lastMessage.info.prompt_tokens &&
      lastMessage.info.completion_tokens
    ) {
      inputTokens = lastMessage.info.prompt_tokens;
      outputTokens = lastMessage.info.completion_tokens;
    } else {
      outputTokens = encode(lastMessage.content).length;
      const totalTokens = data.body.messages.reduce(
        (sum: number, msg: Message) => sum + encode(msg.content).length,
        0
      );
      inputTokens = totalTokens - outputTokens;
    }

    // Calculate total cost
    let totalCost: number;
    if (outputTokens === 0) {
      // If output tokens are 0, no charge
      totalCost = 0;
      console.log("No charge for zero output tokens");
    } else if (modelPrice.per_msg_price >= 0) {
      // If fixed pricing is set, use it directly
      totalCost = Number(modelPrice.per_msg_price);
      console.log(
        `Using fixed pricing: ${totalCost} (${modelPrice.per_msg_price} per message)`
      );
    } else {
      // Otherwise, calculate price by token quantity
      const inputCost = (inputTokens / 1_000_000) * modelPrice.input_price;
      const outputCost = (outputTokens / 1_000_000) * modelPrice.output_price;
      totalCost = inputCost + outputCost;
    }

    // Get the pre-deducted cost when getting inlet
    const inletCost = getModelInletCost(modelId);

    // The actual cost to be deducted = total cost - pre-deducted cost
    const actualCost = totalCost - inletCost;

    // Get and update user balance
    const userResult = await query(
      `UPDATE users 
       SET balance = LEAST(
         balance - CAST($1 AS DECIMAL(16,4)),
         999999.9999
       )
       WHERE id = $2
       RETURNING balance`,
      [actualCost, userId]
    );

    if (userResult.rows.length === 0) {
      throw new Error("User does not exist");
    }

    const newBalance = Number(userResult.rows[0].balance);

    if (newBalance > 999999.9999) {
      throw new Error("Balance exceeds maximum allowed value");
    }

    // Record usage
    await query(
      `INSERT INTO user_usage_records (
        user_id, nickname, model_name, 
        input_tokens, output_tokens, 
        cost, balance_after
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId,
        userName,
        modelId,
        inputTokens,
        outputTokens,
        totalCost,
        newBalance,
      ]
    );

    await query("COMMIT");

    console.log(
      JSON.stringify({
        success: true,
        inputTokens,
        outputTokens,
        totalCost,
        newBalance,
        message: "Request successful",
      })
    );

    return NextResponse.json({
      success: true,
      inputTokens,
      outputTokens,
      totalCost,
      newBalance,
      message: "Request successful",
    });
  } catch (error) {
    await query("ROLLBACK");
    console.error("Outlet error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Error processing request",
        error_type: error instanceof Error ? error.name : "UNKNOWN_ERROR",
      },
      { status: 500 }
    );
  } finally {
    // Only release connection in non-Vercel environment
    if (!isVercel && pgClient && "release" in pgClient) {
      pgClient.release();
    }
  }
}
