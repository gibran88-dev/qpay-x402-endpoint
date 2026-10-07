const crypto = require("crypto");

const SELLER_ID =
  process.env.QUBIC_ADDRESS ||
  "RHFDSXKVQPUGFGCCSXSKZTIQTIGDICUYVPWOLOLUSFFGBFRQIXZKTOPGTRBD";

const TICKET_KEY = process.env.QPAY_TICKET_KEY;

const AMOUNT = "20000";
const RESOURCE_ID = "/feed";
const MAX_TIMEOUT = 120;

// QPAY contract address from the Q+Pay x402 docs
const PAY_TO =
  "DBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHQAH";

function base64url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function createTicket() {
  const nonce = crypto.randomBytes(8).toString("hex");
  const now = Math.floor(Date.now() / 1000);

  const claims = {
    v: "pt1",
    sellerId: SELLER_ID,
    resourceId: RESOURCE_ID,
    amount: AMOUNT,
    nonce,
    iat: now,
    exp: now + 600
  };

  const payload = base64url(
    Buffer.from(JSON.stringify(claims))
  );

  const signature = base64url(
    crypto
      .createHmac("sha256", TICKET_KEY)
      .update(payload)
      .digest()
  );

  return `${payload}.${signature}`;
}

function paymentRequirements(ticket) {
  return {
    scheme: "exact",
    network: "qubic:mainnet",
    amount: AMOUNT,
    asset: "QUBIC",
    payTo: PAY_TO,
    maxTimeoutSeconds: MAX_TIMEOUT,
    extra: {
      sellerId: SELLER_ID,
      resourceId: RESOURCE_ID,
      settlement: "contract"
    }
  };
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  if (!TICKET_KEY) {
    return res.status(500).json({
      error: "QPAY_TICKET_KEY is not configured"
    });
  }

  const paymentHeader = req.headers["x-payment"];

  // No payment yet → return 402
  if (!paymentHeader) {
    const ticket = createTicket();
    const requirements = paymentRequirements(ticket);

    return res.status(402).json({
      x402Version: 2,
      error: "X-PAYMENT header is required",
      accepts: [requirements],
      paymentTicket: ticket,
      paymentTicketField:
        "paymentPayload.payload.ticket"
    });
  }

  try {
    // X-PAYMENT is standard base64 JSON
    const decoded = Buffer.from(
      paymentHeader,
      "base64"
    ).toString("utf8");

    const paymentPayload = JSON.parse(decoded);

    const ticket = paymentPayload?.payload?.ticket;

    if (!ticket) {
      return res.status(402).json({
        x402Version: 2,
        error: "Missing payment ticket"
      });
    }

    const requirements = paymentRequirements(ticket);

    // Ask Q+Pay to verify + settle the payment
    const settlement = await fetch(
      "https://useqpay.com/facilitator/settle",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          paymentPayload,
          paymentRequirements: requirements
        })
      }
    );

    const result = await settlement.json();

    if (!result.success) {
      return res.status(402).json({
        x402Version: 2,
        error: result.errorReason || "Payment not accepted"
      });
    }

    // Payment successfully settled
    return res.status(200).json({
      data: "Q+Pay x402 protected content",
      message: "Payment successful",
      payer: result.payer,
      transaction: result.transaction
    });

  } catch (error) {
    return res.status(400).json({
      error: "Invalid X-PAYMENT"
    });
  }
};
