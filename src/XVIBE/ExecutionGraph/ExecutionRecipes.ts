export type ExecutionRecipeType = "crud";

export type ExecutionRecipeArtifact = {
  _capability: string;
  _artifact_id_template: string;
  _depends_on: string[];
  _required: boolean;
  _children?: ExecutionRecipeArtifact[];
};

export type ExecutionRecipe = {
  _graph_type: ExecutionRecipeType;
  _artifacts: ExecutionRecipeArtifact[];
};

export type ExecutionRecipeTemplateContext = {
  _entity_name: string;
};

const BUILTIN_EXECUTION_RECIPES: Record<ExecutionRecipeType, ExecutionRecipe> = {
  crud: {
    _graph_type: "crud",
    _artifacts: [
      {
        _capability: "entity",
        _artifact_id_template: "{entity}",
        _depends_on: [],
        _required: true,
      },
      {
        _capability: "flow",
        _artifact_id_template: "create-{entity}",
        _depends_on: ["entity"],
        _required: true,
      },
      {
        _capability: "form",
        _artifact_id_template: "create-{entity}",
        _depends_on: ["entity", "flow"],
        _required: true,
      },
      {
        _capability: "view",
        _artifact_id_template: "{entity}-list",
        _depends_on: ["form"],
        _required: false,
        _children: [
          {
            _capability: "table",
            _artifact_id_template: "{entity}-list",
            _depends_on: [],
            _required: false,
          },
        ],
      },
    ],
  },
};

export function substituteExecutionRecipeTemplate(
  template: string,
  context: ExecutionRecipeTemplateContext,
): string {
  return template.replace(/\{entity\}/gu, context._entity_name);
}

function clone_recipe(recipe: ExecutionRecipe): ExecutionRecipe {
  const clone_artifact = (
    artifact: ExecutionRecipeArtifact,
  ): ExecutionRecipeArtifact => ({
    ...artifact,
    _depends_on: [...artifact._depends_on],
    ...(artifact._children
      ? { _children: artifact._children.map(clone_artifact) }
      : {}),
  });

  return {
    _graph_type: recipe._graph_type,
    _artifacts: recipe._artifacts.map(clone_artifact),
  };
}

export class ExecutionRecipeLoader {
  loadRecipe(recipe_type: ExecutionRecipeType): ExecutionRecipe {
    const recipe = BUILTIN_EXECUTION_RECIPES[recipe_type];
    if (!recipe) {
      throw new Error(`Execution recipe not found: ${recipe_type}`);
    }

    return clone_recipe(recipe);
  }
}
