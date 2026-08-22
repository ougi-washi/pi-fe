#define DEFINE_VALUE(name) int name() { return 1; }
DEFINE_VALUE(generated)

template <typename T>
T identity(T value) {
  return value;
}
