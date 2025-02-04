import {
  executeSync,
  getNamedType,
  getNullableType,
  getOperationAST,
  isAbstractType,
  isCompositeType,
  isEnumType,
  isListType,
  isScalarType,
  visit,
} from "graphql";
import type {
  DocumentNode,
  GraphQLResolveInfo,
  GraphQLSchema,
  GraphQLAbstractType,
  GraphQLCompositeType,
  GraphQLNamedType,
  GraphQLScalarType,
  FieldNode,
  FragmentDefinitionNode,
  SelectionNode,
  SelectionSetNode,
} from "graphql";
import { pathToArray } from "graphql/jsutils/Path";
import type { Path } from "graphql/jsutils/Path";
import {
  DefaultMockResolvers,
  createValueResolver,
  DEFAULT_MOCK_RESOLVERS,
  DEFAULT_MOCK_TYPENAME,
} from "./vendor/RelayMockPayloadGenerator";
import type {
  MockData,
  MockResolverContext,
  MockResolvers,
  ValueResolver,
} from "./vendor/RelayMockPayloadGenerator";
import invariant from "invariant";

export type { MockResolvers };

export interface RequestDescriptor<Node = DocumentNode> {
  readonly node: Node;
  readonly variables: Record<string, any>;
}

export interface OperationDescriptor<
  Schema = GraphQLSchema,
  Node = DocumentNode
> {
  readonly schema: Schema;
  readonly request: RequestDescriptor<Node>;
}

interface InternalMockData extends MockData {
  __abstractType?: GraphQLAbstractType;
}

const TYPENAME_KEY = "__typename";

export function generate<TypeMap extends DefaultMockResolvers>(
  operation: OperationDescriptor,
  mockResolvers: MockResolvers<TypeMap> = DEFAULT_MOCK_RESOLVERS as any, // FIXME: Why does TS not accept this?
): { data: MockData } {
  mockResolvers = { ...DEFAULT_MOCK_RESOLVERS, ...mockResolvers };
  const resolveValue = createValueResolver(mockResolvers);

  // RelayMockPayloadGenerator will execute documents that have optional
  // boolean variables that are not passed by the user, but are required
  // inside the document for @include/@skip to work. We rewrite the
  // document to replace these variable references with hardcoded values.
  //
  // TODO: Is this a bug in RelayMockPayloadGenerator?
  const undefinedBooleanVariables: string[] = [];
  getOperationAST(operation.request.node)!.variableDefinitions?.forEach(
    (variableDefinition) => {
      if (
        variableDefinition.type.kind === "NamedType" &&
        variableDefinition.type.name.value === "Boolean" &&
        operation.request.variables[variableDefinition.variable.name.value] ===
          undefined
      ) {
        undefinedBooleanVariables.push(variableDefinition.variable.name.value);
      }
    },
  );

  const document =
    undefinedBooleanVariables.length === 0
      ? operation.request.node
      : rewriteConditionals(operation.request.node, undefinedBooleanVariables);

  const abstractTypeSelections: Path[] = [];

  const result = executeSync({
    schema: operation.schema,
    document: document,
    variableValues: operation.request.variables,
    rootValue: mockCompositeType(
      mockResolvers,
      operation.schema.getQueryType()!,
      null,
      resolveValue,
      null,
      null,
      {},
      operation,
      abstractTypeSelections,
    ),
    fieldResolver: (source: InternalMockData, args, _context, info) => {
      // FIXME: This should not assume a single selection
      const fieldNode: FieldNode = info.fieldNodes[0];
      const selectionName = fieldNode.alias?.value ?? fieldNode.name.value;

      // Explicit null value
      if (source[selectionName] === null) {
        return null;
      }

      const namedReturnType = getNamedType(info.returnType);
      const isList = isListType(getNullableType(info.returnType));
      if (isCompositeType(namedReturnType)) {
        // TODO: This 'is list' logic is also done by the value resolver,
        // so probably need to refactor this code to actually leverage that.
        const generateValue = (userValue?: { __typename?: string }) => {
          // Explicit null value
          if (userValue === null) {
            return null;
          }
          const result = {
            ...userValue,
            ...mockCompositeType(
              mockResolvers,
              namedReturnType,
              userValue?.[TYPENAME_KEY] || null,
              resolveValue,
              fieldNode,
              info,
              args,
              operation,
              abstractTypeSelections,
            ),
          };
          return result;
        };
        if (isList) {
          const value = source[selectionName];
          const result = Array.isArray(value)
            ? value.map(generateValue)
            : [generateValue(value as {})];
          return result;
        } else {
          return generateValue(source[selectionName] as {} | undefined);
        }
      } else if (isScalarType(namedReturnType)) {
        if (source[selectionName] !== undefined) {
          return source[selectionName];
        }
        const result = mockScalar(
          fieldNode,
          args,
          namedReturnType,
          info,
          source.__abstractType || info.parentType,
          resolveValue,
          isList,
        );
        return result;
      } else if (isEnumType(namedReturnType)) {
        if (source[selectionName] !== undefined) {
          const value = source[selectionName];
          return Array.isArray(value)
            ? value.map((e) => String(e).toUpperCase())
            : String(value).toUpperCase();
        }
        const enumValues = namedReturnType.getValues().map((e) => e.name);
        return isList ? enumValues : enumValues[0];
      } else {
        return null;
      }
    },
  });
  if (result.errors) {
    throw new Error(`RelayMockPayloadGenerator: ${result.errors.join(", ")}`);
  }
  invariant(result?.data, "Expected to generate a payload");

  // Replace typenames of abstract type selections that had no concrete selection
  // with the default mock typename.
  abstractTypeSelections.forEach((pathInstance) => {
    const path = pathToArray(pathInstance);
    const object = path.reduce((prev, key) => prev[key], result.data!);
    object.__typename = DEFAULT_MOCK_TYPENAME;
  });

  return result as { data: MockData };
}

function mockCompositeType(
  mockResolvers: MockResolvers | null,
  namedReturnType: GraphQLNamedType,
  userSpecifiedTypename: string | null,
  resolveValue: ValueResolver,
  fieldNode: FieldNode | null,
  info: GraphQLResolveInfo | null,
  args: { [argName: string]: any },
  operation: OperationDescriptor<GraphQLSchema, DocumentNode>,
  abstractTypeSelections: Path[],
) {
  // Get the concrete type selection, concrete type on an abstract type
  // selection, or the abstract type selection.
  let typename = namedReturnType.name;
  let abstractTypeSelectionOnly = false;
  if (isAbstractType(namedReturnType)) {
    invariant(info, "Expected info to be defined");
    const possibleTypeNames = info.fieldNodes.reduce<string[]>(
      (acc, fieldNode) => [
        ...acc,
        ...getPossibleConcreteTypeNamesFromAbstractTypeSelections(
          operation.schema,
          fieldNode.selectionSet!,
          info.fragments,
        ),
      ],
      [],
    );
    if (possibleTypeNames?.length) {
      if (userSpecifiedTypename) {
        if (!possibleTypeNames.includes(userSpecifiedTypename)) {
          throw new Error(
            "Expected user-specified typename to be one of " +
              possibleTypeNames.join(", "),
          );
        }
        typename = userSpecifiedTypename;
      } else {
        typename = possibleTypeNames[0];
      }
    } else {
      abstractTypeSelectionOnly = true;
    }
  }

  const result: InternalMockData = {
    ...getDefaultValues(
      mockResolvers,
      // If a mock resolver is provided for the abstract type, use it.
      mockResolvers && mockResolvers[namedReturnType.name]
        ? namedReturnType.name
        : typename,
      resolveValue,
      fieldNode,
      info,
      args,
    ),
  };

  if (isAbstractType(namedReturnType) && !result[TYPENAME_KEY]) {
    if (abstractTypeSelectionOnly) {
      // When no concrete type selection exists, it means only interface
      // fields are selected, so we can just use the first possible type.
      //
      // We keep a reference to the path so we can rewrite the __typename
      // field in the output after execution to reflect that this not a
      // selection on a concrete type.
      const possibleType = operation.schema.getPossibleTypes(
        namedReturnType,
      )[0];
      invariant(
        possibleType,
        "Expected interface %s to be implemented by at least one concrete type",
        namedReturnType.name,
      );
      typename = possibleType.name;
      invariant(info, "Expected info to be defined");
      abstractTypeSelections.push(info.path);
    }
    result.__typename = typename;
    result.__abstractType = namedReturnType;
  }

  return result;
}

function getDefaultValues(
  mockResolvers: MockResolvers | null,
  typename: string,
  resolveValue: ValueResolver,
  fieldNode: FieldNode | null,
  info: GraphQLResolveInfo | null,
  args: { [argName: string]: any },
) {
  const defaultValues =
    mockResolvers![typename] &&
    (resolveValue(
      typename,
      {
        parentType: null,
        name: fieldNode?.name.value || "",
        alias: fieldNode?.alias?.value || null,
        path: info ? pathToArray(info.path).filter(isString) : [],
        args: args,
      },
      // FIXME: This is disabled here because we're currently doing this work
      // in the field resolver's isCompositeType check.
      // isListType(info.returnType),
      false,
    ) as MockData | undefined);
  invariant(
    defaultValues === undefined || typeof defaultValues === "object",
    "Expected mock resolver to return an object",
  );
  return defaultValues;
}

function isString(value: any): value is string {
  return typeof value === "string";
}

function getPossibleConcreteTypeNamesFromAbstractTypeSelections(
  schema: GraphQLSchema,
  selectionSet: SelectionSetNode,
  fragments: { [key: string]: FragmentDefinitionNode },
) {
  const result: string[] = [];
  selectionSet.selections.forEach((selection) => {
    const fragmentDefinition = getFragmentSelection(selection, fragments);
    if (fragmentDefinition) {
      const typeName = fragmentDefinition.typeCondition?.name.value;
      if (
        // If undefined, it means the selection is an inline fragment on the
        // current type; i.e. on an abstract type.
        typeName === undefined ||
        isAbstractType(schema.getType(typeName))
      ) {
        result.push(
          ...getPossibleConcreteTypeNamesFromAbstractTypeSelections(
            schema,
            fragmentDefinition.selectionSet,
            fragments,
          ),
        );
      } else {
        result.push(typeName);
      }
    }
  });
  return result;
}

function getFragmentSelection(
  selection: SelectionNode,
  fragments: { [key: string]: FragmentDefinitionNode },
) {
  if (selection.kind === "FragmentSpread") {
    const fragmentDoc = fragments[selection.name.value];
    invariant(
      fragmentDoc,
      "Expected a fragment with name %s to exist",
      selection.name.value,
    );
    return fragmentDoc;
  } else if (selection.kind === "InlineFragment") {
    return selection;
  }
}

function mockScalar(
  fieldNode: FieldNode,
  args: { [argName: string]: any },
  type: GraphQLScalarType,
  info: GraphQLResolveInfo,
  parentType: GraphQLCompositeType,
  resolveValue: ValueResolver,
  plural: boolean,
) {
  if (fieldNode.name.value === TYPENAME_KEY) {
    return isAbstractType(parentType) ? DEFAULT_MOCK_TYPENAME : parentType.name;
  }
  const context: MockResolverContext = {
    name: fieldNode.name.value,
    alias: fieldNode.alias?.value || null,
    args,
    path: pathToArray(info.path).filter(isString),
    parentType: isAbstractType(parentType)
      ? DEFAULT_MOCK_TYPENAME
      : parentType.name,
  };
  return resolveValue(type.name, context, plural, undefined);
}

function rewriteConditionals(
  document: DocumentNode,
  undefinedBooleanVariables: string[],
) {
  return visit(document, {
    Directive(node) {
      // Default value for @include is set to false
      if (
        node.name.value === "include" &&
        node.arguments?.[0].value.kind === "Variable" &&
        undefinedBooleanVariables.includes(node.arguments[0].value.name.value)
      ) {
        return {
          ...node,
          arguments: [
            {
              ...node.arguments[0],
              value: {
                kind: "BooleanValue",
                value: false,
              },
            },
          ],
        };
      }
      // Default value for @skip is set to true
      if (
        node.name.value === "skip" &&
        node.arguments?.[0].value.kind === "Variable" &&
        undefinedBooleanVariables.includes(node.arguments[0].value.name.value)
      ) {
        return {
          ...node,
          arguments: [
            {
              ...node.arguments[0],
              value: {
                kind: "BooleanValue",
                value: true,
              },
            },
          ],
        };
      }
    },
  });
}
