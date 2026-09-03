interface SchemaNode {
  required(): SchemaNode;
  default(value: unknown): SchemaNode;
}

function node(): SchemaNode {
  return {
    required: node,
    default: () => node(),
  };
}

const z = Object.assign(node, {
  object: () => node(),
  string: () => node(),
});

export default z;
