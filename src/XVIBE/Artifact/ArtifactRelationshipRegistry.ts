export type ArtifactRelationshipSource = "entity-field";
export type ArtifactRelationshipOperation =
  | "add-field"
  | "rename-field"
  | "deprecate-field"
  | "restore-field";
export type ArtifactRelationshipTarget =
  | "entity"
  | "records"
  | "flow"
  | "form"
  | "table";

export type ArtifactRelationship = {
  _source: ArtifactRelationshipSource;
  _target: ArtifactRelationshipTarget;
  _order: number;
  _operations: ArtifactRelationshipOperation[];
};

const ENTITY_FIELD_RELATIONSHIPS: ArtifactRelationship[] = [
  {
    _source: "entity-field",
    _target: "entity",
    _order: 10,
    _operations: [
      "add-field",
      "rename-field",
      "deprecate-field",
      "restore-field",
    ],
  },
  {
    _source: "entity-field",
    _target: "records",
    _order: 20,
    _operations: ["rename-field"],
  },
  {
    _source: "entity-field",
    _target: "flow",
    _order: 30,
    _operations: [
      "add-field",
      "rename-field",
      "deprecate-field",
      "restore-field",
    ],
  },
  {
    _source: "entity-field",
    _target: "form",
    _order: 40,
    _operations: [
      "add-field",
      "rename-field",
      "deprecate-field",
      "restore-field",
    ],
  },
  {
    _source: "entity-field",
    _target: "table",
    _order: 50,
    _operations: [
      "add-field",
      "rename-field",
      "deprecate-field",
      "restore-field",
    ],
  },
];

export class ArtifactRelationshipRegistry {
  lookup(input: {
    _source: ArtifactRelationshipSource;
    _operation?: ArtifactRelationshipOperation;
  }): ArtifactRelationship[] {
    return ENTITY_FIELD_RELATIONSHIPS
      .filter((relationship) => relationship._source === input._source)
      .filter(
        (relationship) =>
          !input._operation ||
          relationship._operations.includes(input._operation),
      )
      .sort((left, right) => left._order - right._order)
      .map((relationship) => ({
        ...relationship,
        _operations: [...relationship._operations],
      }));
  }
}
