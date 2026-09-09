# Clean recovery task. Run twice to make the syntax signature improve and suppress its alerts.
def normalize(values):
    return [value.strip() for value in values]

assert normalize([' a ', 'b ']) == ['a', 'b']
