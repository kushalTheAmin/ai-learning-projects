"""Multinomial logistic regression trained by full-batch gradient
descent. Zero-initialized, no randomness anywhere: same data in, same
weights out. fit() continues from the current weights, so a training
curve is a sequence of fit() calls with evaluations in between."""

import numpy as np

from calibration.metrics import log_softmax, softmax


class SoftmaxRegression:
    def __init__(self, n_features: int, n_classes: int):
        if n_features < 1 or n_classes < 2:
            raise ValueError("need n_features >= 1 and n_classes >= 2")
        self.weights = np.zeros((n_features, n_classes), dtype=np.float64)
        self.bias = np.zeros(n_classes, dtype=np.float64)

    def logits(self, features: np.ndarray) -> np.ndarray:
        return features @ self.weights + self.bias

    def loss(self, features: np.ndarray, labels: np.ndarray, l2: float) -> float:
        """Mean cross-entropy plus (l2/2)*||W||^2; the bias is not
        penalized."""
        logp = log_softmax(self.logits(features))
        data = -logp[np.arange(labels.shape[0]), labels].mean()
        return float(data + 0.5 * l2 * (self.weights**2).sum())

    def fit(
        self,
        features: np.ndarray,
        labels: np.ndarray,
        epochs: int,
        lr: float,
        l2: float,
    ) -> "SoftmaxRegression":
        if features.shape[0] == 0:
            raise ValueError("cannot fit on zero rows")
        if features.shape[0] != labels.shape[0]:
            raise ValueError("features and labels disagree on length")
        n = features.shape[0]
        onehot = np.zeros((n, self.bias.shape[0]), dtype=np.float64)
        onehot[np.arange(n), labels] = 1.0
        for _ in range(epochs):
            probs = softmax(self.logits(features))
            grad_out = (probs - onehot) / n
            grad_w = features.T @ grad_out + l2 * self.weights
            grad_b = grad_out.sum(axis=0)
            self.weights -= lr * grad_w
            self.bias -= lr * grad_b
        return self
