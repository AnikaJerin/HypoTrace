def normalize(values):
    return [value.strip() for value in values]

assert normalize([' a ', 'b ']) == ['a', 'b']
