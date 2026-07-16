import { _xlog, _xu } from "@xpell/core";
import type {
  XVibeIntentEngineRequest,
  XVibeIntentResult,
  XVibeProjectMemory,
} from "../XVibeTypes.js";
import { ConversationManager } from "../Conversation/ConversationManager.js";
import type { XVibeIntentProcessor } from "./XVibeIntentProcessor.js";

type ProjectPlanTemplate = {
  _domain: string;
  _goal: string;
  _summary: string;
  _entities: {
    _id: string;
    _title: string;
    _fields: string[];
  }[];
  _views: {
    _id: string;
    _title: string;
    _purpose: string;
  }[];
  _flows: {
    _id: string;
    _title: string;
    _purpose: string;
  }[];
  _server_modules: {
    _id: string;
    _title: string;
    _required: boolean;
    _reason: string;
  }[];
  _milestones: {
    _id: string;
    _title: string;
    _items: string[];
  }[];
};

const EXPLICIT_PLANNING_PATTERN =
  /\b(?:plan|design|outline|scope|blueprint)\b[\s\S]*\b(?:app|application|system|project|crm|inventory|dashboard|playlist|hospital|business)\b/iu;
const APP_INTENT_PATTERN =
  /\b(?:i\s+want\s+to\s+build|want\s+to\s+build|build\s+(?:an?\s+)?(?:app|application|system)|app|application|system|project)\b/iu;
const DIRECT_BUILD_PATTERNS: readonly RegExp[] = [
  /^\s*(?:create|add|make)\s+(?:an?\s+)?(?:xdb\s+)?entity\b/iu,
  /^\s*(?:create|add)\s+(?:a\s+)?flow\b/iu,
  /^\s*(?:create|make|add)\s+(?:a\s+)?form(?:\s+view)?\s+for\b/iu,
  /^\s*(?:create|make|add)\s+[\s\S]+?\s+form(?:\s+view)?\b/iu,
  /^\s*(?:create|make|add)\s+(?:a\s+)?(?:table|list)(?:\s+view)?\s+for\b/iu,
  /^\s*(?:create|make|add)\s+[\s\S]+?\s+(?:table|list)(?:\s+view)?\b/iu,
  /^\s*(?:create|make|add)\s+[\s\S]+?\s+crud\b/iu,
  /^\s*(?:create|make|add)\s+crud\s+for\b/iu,
  /^\s*add\s+(?:field\s+)?[a-zA-Z0-9_-]+(?:\s+field)?\s+to\b/iu,
  /^\s*(?:rename|delete|deprecate|restore)\s+[\s\S]+?\s+(?:field|from|to)\b/iu,
];
const NUTRITION_DOMAIN_PATTERN =
  /\b(?:calorie|calories|protein|nutrition|meal|meals|food|diet|macro|macros|tracker|weight|daily nutrition)\b/iu;

function is_direct_build_command(message: string): boolean {
  return DIRECT_BUILD_PATTERNS.some((pattern) => pattern.test(message));
}

function read_memory(
  request: XVibeIntentEngineRequest,
): Partial<XVibeProjectMemory> {
  const memory = request._runtime_context._project_memory;
  return _xu.is_plain_object(memory) ? memory : {};
}

function read_stage(request: XVibeIntentEngineRequest): string {
  const memory = read_memory(request);
  if (typeof memory._stage === "string") return memory._stage;
  if (typeof request._runtime_context._stage === "string") {
    return request._runtime_context._stage;
  }

  return "";
}

function read_conversation_id(request: XVibeIntentEngineRequest): string | undefined {
  if (
    typeof request._conversation_id === "string" &&
    request._conversation_id.trim().length > 0
  ) {
    return request._conversation_id.trim();
  }

  const context_conversation_id =
    request._runtime_context._conversation_id;
  return typeof context_conversation_id === "string" &&
    context_conversation_id.trim().length > 0
    ? context_conversation_id.trim()
    : undefined;
}

function clean_goal_from_message(message: string): string {
  const cleaned = message
    .trim()
    .replace(/[.!?]+$/u, "")
    .replace(/\s+/gu, " ");
  if (!cleaned) return "Plan a business app";

  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function primary_user_question(domain: string): string {
  if (domain === "crm") return "Who will primarily use this CRM?";
  if (domain === "inventory") return "Who will primarily use this inventory app?";
  if (domain === "dashboard") return "Who will primarily use this dashboard?";
  if (domain === "nutrition") return "Who will primarily use this nutrition app?";
  if (domain === "hospital-music") {
    return "Who will primarily use this playlist app?";
  }

  return "Who will primarily use this app?";
}

function primary_user_options(domain: string): string[] {
  if (domain === "nutrition") {
    return ["Personal user", "Friend/Family", "Coach", "Nutritionist", "Other"];
  }

  return ["Sales", "Managers", "Support", "Customers", "Other"];
}

function core_entity_options(domain: string): string[] {
  if (domain === "nutrition") {
    return [
      "Foods",
      "Meals",
      "Daily logs",
      "Nutrition goals",
      "Recipes",
      "Weight entries",
    ];
  }

  return ["Customers", "Products", "Orders", "Tasks", "Other"];
}

function first_workflow_options(domain: string): string[] {
  if (domain === "nutrition") {
    return [
      "Log meal",
      "Search foods",
      "Set daily goals",
      "View daily dashboard",
    ];
  }

  return ["Create record", "Review dashboard", "Approve request", "Assign owner", "Other"];
}

function planning_questions(domain = "generic-business") {
  return [
    {
      _id: "primary_user",
      _type: "multi",
      _question: primary_user_question(domain),
      _options: primary_user_options(domain),
      _required: true,
      _answer: null,
    },
    {
      _id: "core_entities",
      _type: "multi",
      _question: "Which core records should the first version manage?",
      _options: core_entity_options(domain),
      _required: true,
      _answer: null,
    },
    {
      _id: "ai_capabilities",
      _type: "multi",
      _question: "Which AI capabilities should the app include?",
      _options: [
        "None",
        "Chat assistant",
        "Smart suggestions",
        "Image understanding",
        "Document/PDF understanding",
        "Text generation",
        "Automation agent",
      ],
      _required: true,
      _answer: null,
    },
    {
      _id: "notification_capabilities",
      _type: "multi",
      _question: "Which notification capabilities should the app include?",
      _options: ["None", "Email", "Push", "SMS"],
      _required: true,
      _answer: null,
    },
    {
      _id: "reporting_capabilities",
      _type: "multi",
      _question: "Which reporting capabilities should the app include?",
      _options: ["None", "Dashboard", "Charts", "Export PDF", "Export Excel"],
      _required: true,
      _answer: null,
    },
    {
      _id: "integration_capabilities",
      _type: "multi",
      _question: "Which integration capabilities should the app include?",
      _options: ["None", "REST API", "Webhooks", "OAuth", "Third-party APIs"],
      _required: true,
      _answer: null,
    },
    {
      _id: "first_workflow",
      _type: "single",
      _question: "What is the first workflow to build?",
      _options: first_workflow_options(domain),
      _required: true,
      _answer: null,
    },
    {
      _id: "authentication",
      _type: "multi",
      _question: "Is authentication required for the first version?",
      _options: ["No", "Staff login", "Role-based access", "Customer login", "Other"],
      _required: true,
      _answer: null,
    },
  ];
}

function crm_template(): ProjectPlanTemplate {
  return {
    _domain: "crm",
    _goal: "Build a CRM app",
    _summary: "Plan a CRM app for customer tracking and follow-up workflows.",
    _entities: [
      {
        _id: "customer",
        _title: "Customer",
        _fields: ["name", "email", "phone", "status"],
      },
      {
        _id: "contact",
        _title: "Contact",
        _fields: ["name", "email", "phone", "customer_id"],
      },
    ],
    _views: [
      {
        _id: "dashboard",
        _title: "Dashboard",
        _purpose: "Overview and quick actions",
      },
      {
        _id: "customer-list",
        _title: "Customer List",
        _purpose: "Browse and search customers",
      },
    ],
    _flows: [
      {
        _id: "create-customer",
        _title: "Create Customer",
        _purpose: "Create new customer record",
      },
    ],
    _server_modules: [
      {
        _id: "notifications",
        _title: "Notifications",
        _required: false,
        _reason: "Only needed if reminders are required",
      },
    ],
    _milestones: [
      {
        _id: "customer-management",
        _title: "Customer Management",
        _items: ["Customer CRUD", "Search & Filters", "Customer Details"],
      },
    ],
  };
}

function inventory_template(): ProjectPlanTemplate {
  return {
    _domain: "inventory",
    _goal: "Build an inventory app",
    _summary: "Plan an inventory app for products, stock levels, and movement tracking.",
    _entities: [
      {
        _id: "product",
        _title: "Product",
        _fields: ["name", "sku", "quantity", "status"],
      },
      {
        _id: "supplier",
        _title: "Supplier",
        _fields: ["name", "email", "phone", "status"],
      },
    ],
    _views: [
      {
        _id: "dashboard",
        _title: "Dashboard",
        _purpose: "Inventory overview and low-stock signals",
      },
      {
        _id: "product-list",
        _title: "Product List",
        _purpose: "Browse and update products",
      },
    ],
    _flows: [
      {
        _id: "create-product",
        _title: "Create Product",
        _purpose: "Create new product record",
      },
    ],
    _server_modules: [
      {
        _id: "notifications",
        _title: "Notifications",
        _required: false,
        _reason: "Only needed for low-stock alerts",
      },
    ],
    _milestones: [
      {
        _id: "product-management",
        _title: "Product Management",
        _items: ["Product CRUD", "Search & Filters", "Stock Updates"],
      },
    ],
  };
}

function dashboard_template(): ProjectPlanTemplate {
  return {
    _domain: "dashboard",
    _goal: "Build a dashboard app",
    _summary: "Plan a dashboard app for metrics, reports, and operational review.",
    _entities: [
      {
        _id: "metric",
        _title: "Metric",
        _fields: ["name", "value", "category", "updated_at"],
      },
    ],
    _views: [
      {
        _id: "dashboard",
        _title: "Dashboard",
        _purpose: "Show key metrics and quick filters",
      },
    ],
    _flows: [
      {
        _id: "refresh-metrics",
        _title: "Refresh Metrics",
        _purpose: "Update displayed metrics",
      },
    ],
    _server_modules: [],
    _milestones: [
      {
        _id: "dashboard-management",
        _title: "Dashboard Management",
        _items: ["Metric CRUD", "Dashboard View", "Filters"],
      },
    ],
  };
}

function music_playlist_template(): ProjectPlanTemplate {
  return {
    _domain: "hospital-music",
    _goal: "Build a hospital music playlist app",
    _summary: "Plan a playlist app for hospital music scheduling and playlist management.",
    _entities: [
      {
        _id: "playlist",
        _title: "Playlist",
        _fields: ["name", "mood", "department", "status"],
      },
      {
        _id: "track",
        _title: "Track",
        _fields: ["title", "artist", "duration", "status"],
      },
    ],
    _views: [
      {
        _id: "dashboard",
        _title: "Dashboard",
        _purpose: "Overview of playlists and active schedules",
      },
      {
        _id: "playlist-list",
        _title: "Playlist List",
        _purpose: "Browse and manage playlists",
      },
    ],
    _flows: [
      {
        _id: "create-playlist",
        _title: "Create Playlist",
        _purpose: "Create new playlist record",
      },
    ],
    _server_modules: [
      {
        _id: "scheduler",
        _title: "Scheduler",
        _required: false,
        _reason: "Only needed if playback schedules are required",
      },
    ],
    _milestones: [
      {
        _id: "playlist-management",
        _title: "Playlist Management",
        _items: ["Playlist CRUD", "Track Management", "Scheduling"],
      },
    ],
  };
}

function nutrition_template(): ProjectPlanTemplate {
  return {
    _domain: "nutrition",
    _goal: "Build a nutrition app",
    _summary: "Plan a nutrition app for meals, food photos, and nutrition tracking.",
    _entities: [
      {
        _id: "meal",
        _title: "Meal",
        _fields: ["name", "meal_time", "calories", "status"],
      },
      {
        _id: "food-photo",
        _title: "Food Photo",
        _fields: ["image", "meal_id", "recognized_items", "status"],
      },
    ],
    _views: [
      {
        _id: "dashboard",
        _title: "Dashboard",
        _purpose: "Nutrition overview and daily progress",
      },
      {
        _id: "meal-log",
        _title: "Meal Log",
        _purpose: "Capture and review meals",
      },
    ],
    _flows: [
      {
        _id: "log-meal",
        _title: "Log Meal",
        _purpose: "Create a meal record",
      },
    ],
    _server_modules: [],
    _milestones: [
      {
        _id: "meal-tracking",
        _title: "Meal Tracking",
        _items: ["Meal CRUD", "Food Photo Capture", "Nutrition Review"],
      },
    ],
  };
}

function generic_template(): ProjectPlanTemplate {
  return {
    _domain: "generic-business",
    _goal: "Build a business app",
    _summary: "Plan a business app around records, workflows, and a dashboard.",
    _entities: [
      {
        _id: "record",
        _title: "Record",
        _fields: ["name", "status", "owner", "updated_at"],
      },
    ],
    _views: [
      {
        _id: "dashboard",
        _title: "Dashboard",
        _purpose: "Overview and quick actions",
      },
      {
        _id: "record-list",
        _title: "Record List",
        _purpose: "Browse and manage records",
      },
    ],
    _flows: [
      {
        _id: "create-record",
        _title: "Create Record",
        _purpose: "Create new record",
      },
    ],
    _server_modules: [],
    _milestones: [
      {
        _id: "record-management",
        _title: "Record Management",
        _items: ["Record CRUD", "Search & Filters", "Record Details"],
      },
    ],
  };
}

function select_template(message: string, memory: Partial<XVibeProjectMemory>) {
  const focus = typeof memory._current_focus === "string"
    ? memory._current_focus
    : "";
  const goal = typeof memory._goal === "string" ? memory._goal : "";
  const normalized = _xu.normalize_prompt(`${message} ${goal} ${focus}`);

  if (/\b(?:crm|customer relationship|customer management)\b/iu.test(normalized)) {
    return crm_template();
  }
  if (/\b(?:inventory|stock|warehouse|product management)\b/iu.test(normalized)) {
    return inventory_template();
  }
  if (/\b(?:hospital music|music playlist|playlist|music)\b/iu.test(normalized)) {
    return music_playlist_template();
  }
  if (NUTRITION_DOMAIN_PATTERN.test(normalized)) {
    return nutrition_template();
  }
  if (/\b(?:dashboard|metrics|analytics|reporting)\b/iu.test(normalized)) {
    return dashboard_template();
  }

  return generic_template();
}

function should_plan(
  message: string,
  stage: string,
): boolean {
  if (is_direct_build_command(message)) return false;
  if (EXPLICIT_PLANNING_PATTERN.test(message)) return true;
  if (stage === "planning" && APP_INTENT_PATTERN.test(message)) return true;

  return false;
}

export class PlanningProcessor implements XVibeIntentProcessor {
  private diagnostic_reason = "planning_processor_no_match";

  async analyze(
    request: XVibeIntentEngineRequest,
  ): Promise<XVibeIntentResult | null> {
    const message = request._message.trim();
    if (!message) {
      return this.skip("empty_message", request._message);
    }

    const stage = read_stage(request);
    if (!should_plan(message, stage)) {
      return this.skip(
        is_direct_build_command(message)
          ? "direct_build_command"
          : "planning_intent_no_match",
        request._message,
      );
    }

    const memory = read_memory(request);
    const template = select_template(message, memory);
    const memory_goal =
      typeof memory._goal === "string" && memory._goal.trim().length > 0
        ? memory._goal.trim()
        : "";
    const goal = memory_goal || template._goal || clean_goal_from_message(message);
    const focus =
      typeof memory._current_focus === "string" &&
      memory._current_focus.trim().length > 0
        ? memory._current_focus.trim()
        : "";

    const questions = planning_questions(template._domain);
    const first_question = questions[0];
    const plan = {
      _type: "project-plan",
      _stage: "planning",
      _domain: template._domain,
      _goal: goal,
      _summary: focus
        ? `${template._summary} Current focus: ${focus}.`
        : template._summary,
      _questions: questions,
      _answers: {},
      _unanswered: questions.map((question) => question._id),
      _current_question: first_question,
      _status: "collecting-information",
      _proposed: {
        _entities: template._entities,
        _views: template._views,
        _flows: template._flows,
        _server_modules: template._server_modules,
      },
      _milestones: template._milestones,
      _next_step: {
        _title: "Answer planning question",
        _prompt: first_question._question,
        _question_id: first_question._id,
      },
    };

    this.diagnostic_reason = "planning_processor_matched";
    _xlog.log("[xvibe] planning processor matched", {
      _stage: stage || undefined,
      _domain: template._domain,
      _goal: goal,
    });

    ConversationManager.writePlanningDraft({
      _app_id: request._runtime_context._app_id,
      _env: request._runtime_context._env,
      _conversation_id: read_conversation_id(request),
      _draft: plan,
    });

    return {
      _message_type: "planning",
      _execution_level: "planning",
      _should_mutate: false,
      _confidence: 1,
      _reason: "project_planning_intent",
      _artifact_type: "project-plan",
      _artifact_request: plan,
      _actions: [],
    };
  }

  _diagnostic_reason(): string | undefined {
    return this.diagnostic_reason;
  }

  private skip(reason: string, prompt: string): null {
    this.diagnostic_reason = reason;
    _xlog.log("[xvibe] planning processor skipped", {
      _reason: reason,
      _prompt: _xu.normalize_prompt(prompt),
    });
    return null;
  }
}
