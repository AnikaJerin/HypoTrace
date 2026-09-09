# Intentional boundary failure.
def final_item(values):
    return values[len(values)]

assert final_item([1, 2, 3]) == 3
