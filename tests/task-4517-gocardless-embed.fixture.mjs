export const FORM_SLUG = "task-4517-gocardless-form";
export const PAGE_SLUG = "task-4517-gocardless-canvas";
export const FIELD_ID = "task-4517-payment";

function paymentFormFixture({
  provider = "gocardless",
  layoutType = "standard",
  normalSubmission = false,
} = {}) {
  const fields = [
    { id: "task-4517-name", type: "text", label: "Name", required: true },
  ];
  if (!normalSubmission) {
    fields.push(
      {
        id: "task-4517-price",
        type: "number",
        label: "Price",
        starts_hidden: true,
        default_value: 120,
      },
      {
        id: FIELD_ID,
        type: "payment",
        label: "Membership payment",
        payment_currency: "GBP",
        payment_providers: [provider],
        price_field_id: "task-4517-price",
      },
    );
  }
  return {
    id: "task-4517-form",
    slug: FORM_SLUG,
    name: "Direct Debit sizing fixture",
    description: "A short real form used to exercise the GoCardless overlay.",
    form_type: "application",
    layout_type: layoutType,
    require_authentication: false,
    is_active: true,
    prefill_source: "none",
    pages: [],
    fields,
    visibility_rules: [],
    entity_pipelines: {},
    structured_actions: { version: 1, actions: [] },
  };
}

function formBlock(id, y) {
  const geom = { x: 40, y, w: 920, h: 420 };
  return {
    id,
    type: "form-embed",
    geom,
    bp: {
      desktop: geom,
      tablet: { x: 24, y, w: 720, h: 420 },
      mobile: { x: 8, y, w: 359, h: 420 },
    },
    content: { formSlug: FORM_SLUG, mode: "iframe", title: `Direct Debit form ${id}` },
    style: {
      background: "#f8fafc",
      borderColor: "#cbd5e1",
      borderWidth: 1,
      borderStyle: "solid",
    },
  };
}

function textBlock(id, y, height, html) {
  const geom = { x: 40, y, w: 920, h: height };
  return {
    id,
    type: "text",
    geom,
    bp: {
      desktop: geom,
      tablet: { x: 24, y, w: 720, h: height },
      mobile: { x: 8, y, w: 359, h: height },
    },
    content: { html },
    style: {},
  };
}

function canvasPageFixture({ longPage = false } = {}) {
  const firstY = longPage ? 1500 : 160;
  const secondY = longPage ? 2180 : 760;
  const downstreamY = longPage ? 2860 : 1360;
  return {
    id: "task-4517-canvas-page",
    slug: PAGE_SLUG,
    name: "GoCardless Canvas sizing fixture",
    status: "published",
    builder_type: "canvas",
    public_chrome: "none",
    canvas_design: {
      version: 1,
      root: {
        sections: [{
          id: "root",
          children: [
            textBlock("task-4517-intro", 40, 60, "<h1>GoCardless sizing fixture</h1>"),
            formBlock("task-4517-form-a", firstY),
            formBlock("task-4517-form-b", secondY),
            textBlock(
              "task-4517-downstream",
              downstreamY,
              80,
              "<h2>Downstream fixture content</h2><p>This must remain below both forms.</p>",
            ),
          ],
        }],
      },
    },
  };
}

function fulfillJson(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

export async function installGoCardlessCanvasFixture(page, {
  sdkMode = "ready",
  confirmationStatus = "setup_complete",
  confirmationPaymentProvider = null,
  alreadyPaid = false,
  provider = "gocardless",
  layoutType = "standard",
  normalSubmission = false,
  longPage = false,
  delayOverlayRemovalMs = 0,
} = {}) {
  const baseURL = process.env.PLAYWRIGHT_BASE_URL
    || (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : "http://127.0.0.1:5000");
  const localOrigin = new URL(baseURL).origin;
  const hostedFallbackUrl = `${localOrigin}/task-4517-hosted-fallback`;
  const state = {
    paymentCalls: [],
    blockedWrites: [],
    blockedExternalRequests: [],
    pageErrors: [],
    successReadyMessages: [],
  };
  page.on("pageerror", error => state.pageErrors.push(error.message));

  await page.addInitScript(({ mode, overlayDelay }) => {
    localStorage.setItem("cookie-consent", "declined");
    if (window.self === window.top) {
      window.__task4570SuccessMessages = [];
      window.addEventListener("message", event => {
        if (event.data?.type === "iconn-form-success-ready") {
          window.__task4570SuccessMessages.push({
            source: event.source,
            origin: event.origin,
            at: performance.now(),
          });
        }
      });
    }
    window.Stripe = () => ({
      elements: () => ({
        create: type => ({
          mount: element => { element.dataset.task4570StripeElement = type; },
        }),
        submit: async () => ({}),
      }),
      confirmPayment: async () => ({
        paymentIntent: { id: "pi_task_4570", status: "succeeded" },
      }),
    });
    window.__task4517Gc = {
      opens: 0,
      exits: 0,
      exitCallbacks: 0,
      successes: 0,
      receipts: 0,
    };
    if (mode === "load-failure") return;
    window.GoCardlessDropin = {
      create(options) {
        let receipt = null;
        const removeReceipt = () => {
          if (receipt?.isConnected) receipt.remove();
          receipt = null;
          window.__task4517Gc.receipts = document.querySelectorAll(
            'body > iframe[id^="gocardless-dropin-iframe-"]',
          ).length;
        };
        const handler = {
          open() {
            window.__task4517Gc.opens += 1;
            if (mode === "open-failure") throw new Error("Fixture Drop-in open failure");
            receipt = document.createElement("iframe");
            receipt.id = `gocardless-dropin-iframe-${window.__task4517Gc.opens}`;
            receipt.title = "Secure Direct Debit setup";
            receipt.style.cssText = [
              "position:fixed",
              "inset:0",
              "width:100%",
              "height:100%",
              "border:0",
              "z-index:2147483647",
              "background:#f1f5f9",
            ].join(";");
            receipt.srcdoc = `<!doctype html><style>
              *{box-sizing:border-box}body{margin:0;background:#e2e8f0;font:16px system-ui;color:#0f172a}
              main{width:min(520px,calc(100% - 32px));margin:70px auto;background:white;border-radius:14px;padding:28px;
              box-shadow:0 12px 40px #0f172a33}.provider-steps{height:760px}small{color:#475569}
              button{display:block;width:100%;padding:14px;border:0;border-radius:8px;background:#155e75;color:white}
            </style><main><h1>Set up Direct Debit</h1><p>Secure provider-shaped sizing fixture</p>
            <div class="provider-steps"><small>No bank details are collected and no mandate is created.</small></div>
            <button id="provider-bottom-control">Continue securely</button></main>`;
            document.body.appendChild(receipt);
            window.__task4517Gc.receipts = 1;
          },
          exit() {
            window.__task4517Gc.exits += 1;
            if (overlayDelay > 0) setTimeout(removeReceipt, overlayDelay);
            else removeReceipt();
            window.__task4517Gc.exitCallbacks += 1;
            options.onExit?.(null, { source: "handler-exit" });
          },
        };
        window.__task4517Gc.userExit = () => {
          removeReceipt();
          window.__task4517Gc.exitCallbacks += 1;
          options.onExit?.(null, { source: "user-exit" });
        };
        window.__task4517Gc.success = () => {
          window.__task4517Gc.successes += 1;
          // The real provider reports success before React unmounts the wrapper.
          // Deliberately leave the body receipt connected so cleanup is tested.
          options.onSuccess?.({ id: "BRQ_fixture" }, { id: "BRF_fixture" });
        };
        window.__task4517Gc.receiptSuccessBeforeReturn = () => {
          receipt?.contentDocument?.documentElement.setAttribute("data-provider-success", "reported");
        };
        return handler;
      },
    };
  }, { mode: sdkMode, overlayDelay: delayOverlayRemovalMs });

  await page.context().route("**/*", route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== localOrigin) {
      const knownStaticHost = [
        "cdnjs.cloudflare.com",
        "fonts.googleapis.com",
        "fonts.gstatic.com",
        "js.stripe.com",
        "va.vercel-scripts.com",
        "teeone.pythonanywhere.com",
      ].includes(url.hostname);
      if (!knownStaticHost && !url.pathname.includes("/storage/v1/object/public/")) {
        state.blockedExternalRequests.push(`${request.method()} ${url.href}`);
      }
      return route.abort();
    }
    if (!["GET", "HEAD", "OPTIONS", "POST"].includes(request.method())) {
      state.blockedWrites.push(`${request.method()} ${url.href}`);
      return fulfillJson(route, { error: "Fixture blocks writes" }, 599);
    }
    return route.continue();
  });
  await page.context().route(/\/(?:rest|auth)\/v1\//, route => {
    if (!["GET", "HEAD", "OPTIONS"].includes(route.request().method())) {
      state.blockedWrites.push(`${route.request().method()} ${route.request().url()}`);
      return fulfillJson(route, { error: "Fixture blocks Supabase writes" }, 599);
    }
    return fulfillJson(route, []);
  });
  await page.context().route("**/task-4517-hosted-fallback", route => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><title>Hosted fallback fixture</title><main>Hosted fallback opened safely</main>",
  }));
  await page.context().route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // The glob also matches source modules under /src/api/. They must continue
    // to Vite rather than receiving a JSON fixture response.
    if (!path.startsWith("/api/")) return route.continue();
    if (path === `/api/public/form/${FORM_SLUG}` && request.method() === "GET") {
      return fulfillJson(route, paymentFormFixture({ provider, layoutType, normalSubmission }));
    }
    if (path === `/api/public/page/${PAGE_SLUG}` && request.method() === "GET") {
      return fulfillJson(route, { page: canvasPageFixture({ longPage }), elements: [], symbols: [] });
    }
    if (path === "/api/public/form-payment-providers" && request.method() === "GET") {
      return fulfillJson(route, { providers: [{ id: provider, configured: true }] });
    }
    if (path === "/api/public/form-submission" && request.method() === "POST") {
      if (!normalSubmission) {
        state.blockedWrites.push(`${request.method()} ${path}`);
        return fulfillJson(route, { error: "Unexpected non-payment submission" }, 599);
      }
      state.paymentCalls.push({ action: "normal-submit", ...request.postDataJSON() });
      return fulfillJson(route, { success: true, submission_id: "task-4570-normal-submission" });
    }
    if (path === "/api/public/form-payment" && request.method() === "POST") {
      const body = request.postDataJSON();
      state.paymentCalls.push(body);
      if (body.action === "create") {
        if (alreadyPaid) {
          return fulfillJson(route, {
            submissionId: "task-4517-submission",
            provider,
            alreadyPaid: true,
          });
        }
        if (provider === "stripe") {
          return fulfillJson(route, {
            submissionId: "task-4517-submission",
            publishableKey: "pk_test_task_4570",
            clientSecret: "cs_test_task_4570",
          });
        }
        return fulfillJson(route, {
          submissionId: "task-4517-submission",
          flowId: "BRF_task_4517",
          environment: "sandbox",
          authorisationUrl: hostedFallbackUrl,
        });
      }
      if (body.action === "confirm") {
        return fulfillJson(route, {
          status: confirmationStatus,
          provider,
          paymentProvider: confirmationPaymentProvider
            || (provider === "gocardless" ? "gocardless_monthly_dd" : "stripe"),
          setupVerified: provider === "gocardless"
            && confirmationPaymentProvider !== "gocardless",
          paymentSucceeded: provider === "stripe",
        });
      }
      return fulfillJson(route, { error: "Unexpected payment fixture action" }, 599);
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      state.blockedWrites.push(`${request.method()} ${path}`);
      return fulfillJson(route, { error: "Fixture blocks unhandled writes" }, 599);
    }
    if (path === "/api/auth/me") return fulfillJson(route, null, 401);
    if (path === "/api/auth/tenant-user-me") return fulfillJson(route, { user: null }, 401);
    if (path === "/api/public/microsites") return fulfillJson(route, { microsites: [] });
    if (path === "/api/public/tenant-branding") {
      return fulfillJson(route, {
        success: true,
        branding: { name: "Sizing fixture", primaryColor: "#155e75", footerSource: "standard" },
      });
    }
    if (path === "/api/public/navigation-items") return fulfillJson(route, []);
    return fulfillJson(route, []);
  });
  return state;
}

export async function outerFrameMetrics(page, index = 0) {
  return page.locator('[data-testid="iframe-form-embed"]').nth(index).evaluate(iframe => {
    const block = iframe.closest("[data-cb]");
    const rect = iframe.getBoundingClientRect();
    const blockRect = block.getBoundingClientRect();
    const receipt = iframe.contentDocument.querySelector(
      'body > iframe[id^="gocardless-dropin-iframe-"]',
    );
    return {
      height: rect.height,
      width: rect.width,
      blockHeight: blockRect.height,
      blockTop: blockRect.top + scrollY,
      blockBottom: blockRect.bottom + scrollY,
      background: getComputedStyle(block).backgroundColor,
      intrinsic: Math.max(
        iframe.contentDocument.querySelector("[data-form-embed-content]")?.scrollHeight || 0,
        iframe.contentDocument.querySelector("[data-form-embed-content]")?.getBoundingClientRect().height || 0,
      ),
      receipt: receipt ? {
        id: receipt.id,
        connected: receipt.isConnected,
        parent: receipt.parentElement?.tagName,
        position: getComputedStyle(receipt).position,
        height: receipt.getBoundingClientRect().height,
        width: receipt.getBoundingClientRect().width,
      } : null,
    };
  });
}

export async function blockTop(page, id) {
  return page.locator(`[data-cb="${id}"]`).evaluate(block => {
    const rect = block.getBoundingClientRect();
    return rect.top + scrollY;
  });
}